use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agent::{data_root, default_catalog, ComponentSpec};
use crate::config::model_config_path;
use crate::sv2_concurrent::detect_provider as detect_sandboxie;
use crate::synthv::{failed, quiet_command, succeeded, OperationResult};

const SANDBOXIE_VERSION: &str = "1.18.2";
const SANDBOXIE_INSTALLER_NAME: &str = "Sandboxie-Plus-x64-v1.18.2.exe";
const SANDBOXIE_INSTALLER_URL: &str =
    "https://github.com/sandboxie-plus/Sandboxie/releases/download/v1.18.2/Sandboxie-Plus-x64-v1.18.2.exe";
const SANDBOXIE_INSTALLER_SHA256: &str =
    "1c19832c8bb84f5dcde1bf59b7f38b7cfe94989c09dd0acd0b7ce7485dde8987";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub audience: String,
    pub installed: bool,
    pub downloaded: bool,
    pub installable: bool,
    pub status: String,
}

pub fn component_list(resource_root: &Path) -> Vec<ComponentInfo> {
    let mut components = default_catalog()
        .into_iter()
        .filter(|component| matches!(component.id.as_str(), "ffmpeg" | "pi-audio" | "cvrs"))
        .map(|component| component_info(component, resource_root))
        .collect::<Vec<_>>();
    components.push(sandboxie_component_info());
    components
}

fn component_info(component: ComponentSpec, resource_root: &Path) -> ComponentInfo {
    let installed = match component.id.as_str() {
        "ffmpeg" => {
            bundled_binary(resource_root, "ffmpeg").is_some() || command_available("ffmpeg")
        }
        "pi-audio" => configured_component("audio"),
        "cvrs" => configured_component("cvrs"),
        _ => false,
    };
    let id = component.id;
    let installable = installed || matches!(id.as_str(), "pi-audio" | "cvrs");
    ComponentInfo {
        id,
        display_name: component.display_name,
        description: component.description,
        audience: match format!("{:?}", component.audience).as_str() {
            "Ai" => "AI".to_string(),
            "Human" => "人工".to_string(),
            _ => "AI 与人工".to_string(),
        },
        installed,
        downloaded: false,
        status: if installed {
            "已就绪".to_string()
        } else if installable {
            "可通过 aria2 下载".to_string()
        } else {
            "需要系统安装".to_string()
        },
        installable,
    }
}

pub fn install_component<F>(
    id: &str,
    components_dir: &Path,
    resource_root: &Path,
    mut progress: F,
) -> OperationResult
where
    F: FnMut(&str, u8, &str),
{
    match id {
        "ffmpeg" => {
            progress("installing", 80, "正在检查系统或应用内 FFmpeg。");
            if bundled_binary(resource_root, "ffmpeg").is_some() || command_available("ffmpeg") {
                succeeded("FFmpeg 已可用。", "已发现应用内或系统 FFmpeg。")
            } else {
                failed(
                    "当前平台包未包含 FFmpeg。",
                    "为避免不可信下载，应用不会自动安装未锁定哈希的二进制。请安装 FFmpeg，或在发布构建中提供对应平台的签名资源。",
                )
            }
        }
        "pi-audio" | "cvrs" => {
            let source = if std::env::var("SYNTHV_TOOLBOX_COMPONENT_SOURCE")
                .is_ok_and(|value| value.eq_ignore_ascii_case("bundled"))
            {
                progress("downloading", 50, "开发模式：使用应用包内的组件源码。");
                Ok(components_dir.join(id))
            } else {
                download_component_source(id, resource_root, &mut progress)
            };
            let source = match source {
                Ok(source) => source,
                Err(error) => return failed("组件下载失败。", error),
            };
            progress("installing", 68, "源码校验完成，正在创建本地运行环境。");
            match id {
                "pi-audio" => install_python_component(id, "pi_audio.py", "audio", true, &source),
                "cvrs" => install_python_component(id, "cvrs.py", "cvrs", false, &source),
                _ => unreachable!(),
            }
        }
        "sandboxie" => download_sandboxie_installer(resource_root, &mut progress),
        _ => failed(
            "此组件尚无可信的跨平台安装清单。",
            "已拒绝下载；请等待包含来源、版本和 SHA-256 的发布清单。",
        ),
    }
}

fn sandboxie_component_info() -> ComponentInfo {
    let installed = cfg!(windows) && detect_sandboxie().is_ok();
    let downloaded = cfg!(windows) && sandboxie_installer_path().is_file();
    let installable = cfg!(all(windows, target_arch = "x86_64"));
    ComponentInfo {
        id: "sandboxie".to_string(),
        display_name: format!("Sandboxie Plus {SANDBOXIE_VERSION}"),
        description: "SynthV Toolbox 并发隔离提供方；下载官方安装包后由用户交互安装。".to_string(),
        audience: "Windows 并发隔离".to_string(),
        installed,
        downloaded,
        installable,
        status: if installed {
            "已检测到受支持的 Sandboxie".to_string()
        } else if downloaded {
            "官方安装包已下载；等待用户安装".to_string()
        } else if installable {
            "可通过 aria2 下载官方 x64 安装包".to_string()
        } else {
            "仅适用于 Windows x64".to_string()
        },
    }
}

fn download_sandboxie_installer<F>(resource_root: &Path, progress: &mut F) -> OperationResult
where
    F: FnMut(&str, u8, &str),
{
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return failed(
            "Sandboxie 安装包仅适用于 Windows x64。",
            "macOS 不使用 Sandboxie；账号并发隔离在 Windows 上提供。",
        );
    }
    let directory = sandboxie_download_directory();
    if let Err(error) = fs::create_dir_all(&directory) {
        return failed("无法创建 Sandboxie 下载目录。", error.to_string());
    }
    let installer = sandboxie_installer_path();
    if installer.is_file() && verify_sha256(&installer, SANDBOXIE_INSTALLER_SHA256).is_ok() {
        return succeeded(
            "Sandboxie 官方安装包已经下载。",
            format!("安装包：{}；工具箱不会静默安装驱动。", installer.display()),
        );
    }
    let Some(aria2) = find_aria2(resource_root) else {
        return failed(
            "未找到 aria2c。",
            "请安装 aria2，或设置 SYNTHV_TOOLBOX_ARIA2 指向 aria2c。",
        );
    };
    progress(
        "downloading",
        12,
        &format!("aria2 正在下载 Sandboxie Plus {SANDBOXIE_VERSION} 官方安装包。"),
    );
    let payload = ComponentPayload {
        name: SANDBOXIE_INSTALLER_NAME,
        relative_url: "",
        sha256: SANDBOXIE_INSTALLER_SHA256,
    };
    if let Err(error) = download_with_aria2(&aria2, SANDBOXIE_INSTALLER_URL, &directory, &payload) {
        return failed("Sandboxie 安装包下载失败。", error);
    }
    progress(
        "downloading",
        96,
        "Sandboxie 官方安装包已通过 SHA-256 校验。",
    );
    succeeded(
        "Sandboxie 官方安装包已下载。",
        format!(
            "安装包：{}；请从组件中心打开其位置并手动安装。",
            installer.display()
        ),
    )
}

pub fn open_component_download(id: &str) -> OperationResult {
    if id != "sandboxie" {
        return failed("该组件没有可打开的安装包。", id);
    }
    if !cfg!(windows) {
        return failed("Sandboxie 安装包仅适用于 Windows。", "");
    }
    let installer = sandboxie_installer_path();
    if !installer.is_file() {
        return failed("尚未下载 Sandboxie 安装包。", installer.to_string_lossy());
    }
    if let Err(error) = verify_sha256(&installer, SANDBOXIE_INSTALLER_SHA256) {
        return failed("Sandboxie 安装包校验失败，已拒绝打开。", error);
    }
    #[cfg(windows)]
    {
        let argument = format!("/select,{}", installer.to_string_lossy());
        if let Err(error) = quiet_command("explorer.exe").arg(argument).spawn() {
            return failed("无法打开 Sandboxie 安装包位置。", error.to_string());
        }
    }
    succeeded(
        "已打开 Sandboxie 安装包位置。",
        "请由你确认并完成交互安装；工具箱不会静默安装内核驱动。",
    )
}

fn sandboxie_download_directory() -> PathBuf {
    data_root()
        .join("downloads")
        .join("sandboxie")
        .join(SANDBOXIE_VERSION)
}

fn sandboxie_installer_path() -> PathBuf {
    sandboxie_download_directory().join(SANDBOXIE_INSTALLER_NAME)
}

fn install_python_component(
    id: &str,
    script_name: &str,
    config_key: &str,
    install_requirements: bool,
    source: &Path,
) -> OperationResult {
    if !source.join(script_name).is_file() {
        return failed("组件源码不完整。", source.to_string_lossy());
    }
    let target = data_root().join("components").join(id);
    if let Err(error) = copy_directory(source, &target) {
        return failed("复制组件失败。", error.to_string());
    }
    let Some(python) = find_python() else {
        return failed(
            "未找到 Python 3.11。",
            "请安装 Python 3.11，并确保 python3 或 python 可以启动。也可设置 SYNTHV_TOOLBOX_PYTHON。",
        );
    };
    let venv = target.join("venv");
    let venv_python = if cfg!(windows) {
        venv.join("Scripts/python.exe")
    } else {
        venv.join("bin/python3")
    };
    if !venv_python.is_file() {
        let output = quiet_command(&python)
            .args(["-m", "venv"])
            .arg(&venv)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        if !output.is_ok_and(|output| output.status.success()) {
            return failed("无法创建 Python 虚拟环境。", venv.to_string_lossy());
        }
    }
    if install_requirements {
        let requirements = target.join("requirements.txt");
        let mut command = quiet_command(&venv_python);
        command
            .args(["-m", "pip", "install", "-r"])
            .arg(&requirements)
            .args(["--disable-pip-version-check"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Ok(index) = std::env::var("SYNTHV_TOOLBOX_PYPI_INDEX") {
            if !index.trim().is_empty() {
                command.args(["--index-url", index.trim()]);
            }
        }
        match command.output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                return failed(
                    "组件依赖安装失败。",
                    String::from_utf8_lossy(&output.stderr)
                        .chars()
                        .take(1600)
                        .collect::<String>(),
                )
            }
            Err(error) => return failed("无法启动 pip。", error.to_string()),
        }
    }
    let script = target.join(script_name);
    if let Err(error) = save_component_config(config_key, &venv_python, &script) {
        return failed("组件已复制，但无法保存配置。", error);
    }
    succeeded(
        format!("{} 已安装。", display_name(id)),
        format!("安装位置：{}", target.to_string_lossy()),
    )
}

const PI_AGENT_COMPONENT_REVISION: &str = "f4d56296d17c30077248fe9f73a13af47a329f62";

struct ComponentPayload {
    name: &'static str,
    relative_url: &'static str,
    sha256: &'static str,
}

const PI_AUDIO_PAYLOADS: &[ComponentPayload] = &[
    ComponentPayload {
        name: "pi_audio.py",
        relative_url: "components/pi-audio/pi_audio.py",
        sha256: "0e00ccd56c928475a69f39981c1f66298fc15d5249e9e7b6efa673b4ca2a4097",
    },
    ComponentPayload {
        name: "requirements.txt",
        relative_url: "components/pi-audio/requirements.txt",
        sha256: "4014ba330a2db128da28ec3782339c474df5fb1f4f0ab70842960cf5c650883e",
    },
];

const CVRS_PAYLOADS: &[ComponentPayload] = &[ComponentPayload {
    name: "cvrs.py",
    relative_url: "components/cvrs/cvrs.py",
    sha256: "71383517bdfc4394315592cf97ab2243d6fff89f0caa24ceb2ca560671354f1e",
}];

fn download_component_source<F>(
    id: &str,
    resource_root: &Path,
    progress: &mut F,
) -> Result<PathBuf, String>
where
    F: FnMut(&str, u8, &str),
{
    let payloads = match id {
        "pi-audio" => PI_AUDIO_PAYLOADS,
        "cvrs" => CVRS_PAYLOADS,
        _ => return Err("该组件没有受信任的 aria2 下载清单。".to_string()),
    };
    let aria2 = find_aria2(resource_root).ok_or_else(|| {
        "未找到 aria2c。请安装 aria2（Windows 可使用 winget/choco，macOS 可使用 Homebrew），或设置 SYNTHV_TOOLBOX_ARIA2 指向 aria2c。".to_string()
    })?;
    let cache = data_root()
        .join("downloads")
        .join(id)
        .join(PI_AGENT_COMPONENT_REVISION);
    fs::create_dir_all(&cache).map_err(|error| format!("无法创建组件下载缓存：{error}"))?;
    for (index, payload) in payloads.iter().enumerate() {
        let start = 8 + ((index * 48) / payloads.len()) as u8;
        progress(
            "downloading",
            start,
            &format!("aria2 正在下载 {}。", payload.name),
        );
        let url = format!(
            "https://raw.githubusercontent.com/SynthVCopilot/pi-agent/{PI_AGENT_COMPONENT_REVISION}/{}",
            payload.relative_url
        );
        download_with_aria2(&aria2, &url, &cache, payload)?;
        let complete = 8 + (((index + 1) * 48) / payloads.len()) as u8;
        progress(
            "downloading",
            complete,
            &format!("{} 已通过 SHA-256 校验。", payload.name),
        );
    }
    Ok(cache)
}

fn find_aria2(resource_root: &Path) -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("SYNTHV_TOOLBOX_ARIA2").map(PathBuf::from) {
        if configured.is_file() {
            return Some(configured);
        }
    }
    let bundled = if cfg!(windows) {
        resource_root.join("download-tools/windows/aria2c.exe")
    } else {
        resource_root.join("download-tools/macos/aria2c")
    };
    if bundled.is_file() {
        return Some(bundled);
    }
    quiet_command("aria2c")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
        .then(|| PathBuf::from("aria2c"))
}

fn download_with_aria2(
    aria2: &Path,
    url: &str,
    directory: &Path,
    payload: &ComponentPayload,
) -> Result<(), String> {
    let output = quiet_command(aria2)
        .args([
            "--allow-overwrite=true",
            "--auto-file-renaming=false",
            "--check-certificate=true",
            "--console-log-level=warn",
            "--continue=true",
            "--download-result=hide",
            "--file-allocation=none",
            "--max-connection-per-server=8",
            "--min-split-size=1M",
        ])
        .arg(format!("--checksum=sha-256={}", payload.sha256))
        .arg("--dir")
        .arg(directory)
        .arg("--out")
        .arg(payload.name)
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("无法启动 aria2c：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1600)
            .collect::<String>();
        return Err(format!(
            "aria2c 下载 {} 失败（退出码 {:?}）：{}",
            payload.name,
            output.status.code(),
            detail.trim()
        ));
    }
    verify_sha256(&directory.join(payload.name), payload.sha256)
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("无法读取下载文件 {}：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("无法校验下载文件 {}：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "下载文件 {} 的 SHA-256 不匹配；已拒绝安装。",
            path.display()
        ))
    }
}

fn configured_component(key: &str) -> bool {
    let value: Value = fs::read_to_string(model_config_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let Some(section) = value.get(key) else {
        return false;
    };
    let python = section
        .get("python")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let script = section
        .get("script")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    python.is_some_and(|path| path.is_file()) && script.is_some_and(|path| path.is_file())
}

fn save_component_config(key: &str, python: &Path, script: &Path) -> Result<(), String> {
    let path = model_config_path();
    let mut value: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}));
    let root = value
        .as_object_mut()
        .ok_or_else(|| "config.json 不是对象".to_string())?;
    root.insert(
        key.to_string(),
        json!({
            "python": python.to_string_lossy(),
            "script": script.to_string_lossy(),
        }),
    );
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn find_python() -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(configured) = std::env::var("SYNTHV_TOOLBOX_PYTHON") {
        candidates.push(configured);
    }
    candidates.extend(["python3".to_string(), "python".to_string()]);
    candidates.into_iter().find(|candidate| {
        quiet_command(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

fn command_available(command: &str) -> bool {
    quiet_command(command)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn bundled_binary(resource_root: &Path, name: &str) -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let candidate = resource_root.join("ffmpeg").join(filename);
    candidate.is_file().then_some(candidate)
}

fn copy_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        if path.file_name().is_some_and(|name| name == "__pycache__") {
            continue;
        }
        let target = destination.join(entry.file_name());
        if path.is_dir() {
            copy_directory(&path, &target)?;
        } else if path.extension().is_none_or(|extension| extension != "pyc") {
            fs::copy(path, target)?;
        }
    }
    Ok(())
}

fn display_name(id: &str) -> &str {
    match id {
        "pi-audio" => "pi-audio",
        "cvrs" => "CVRS",
        _ => id,
    }
}
