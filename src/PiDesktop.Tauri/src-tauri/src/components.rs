use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use pi_agent_core::{default_catalog, ComponentSpec};
use serde::Serialize;
use serde_json::{json, Value};

use crate::config::model_config_path;
use crate::synthv::{failed, quiet_command, succeeded, OperationResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub audience: String,
    pub installed: bool,
    pub status: String,
}

pub fn component_list(resource_root: &Path) -> Vec<ComponentInfo> {
    default_catalog()
        .into_iter()
        .filter(|component| matches!(component.id.as_str(), "ffmpeg" | "pi-audio" | "cvrs"))
        .map(|component| component_info(component, resource_root))
        .collect()
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
    ComponentInfo {
        id: component.id,
        display_name: component.display_name,
        description: component.description,
        audience: match format!("{:?}", component.audience).as_str() {
            "Ai" => "AI".to_string(),
            "Human" => "人工".to_string(),
            _ => "AI 与人工".to_string(),
        },
        installed,
        status: if installed {
            "已就绪".to_string()
        } else {
            "未安装".to_string()
        },
    }
}

pub fn install_component(id: &str, components_dir: &Path, resource_root: &Path) -> OperationResult {
    match id {
        "ffmpeg" => {
            if bundled_binary(resource_root, "ffmpeg").is_some() || command_available("ffmpeg") {
                succeeded("FFmpeg 已可用。", "已发现应用内或系统 FFmpeg。")
            } else {
                failed(
                    "当前平台包未包含 FFmpeg。",
                    "为避免不可信下载，应用不会自动安装未锁定哈希的二进制。请安装 FFmpeg，或在发布构建中提供对应平台的签名资源。",
                )
            }
        }
        "pi-audio" => install_python_component(id, "pi_audio.py", "audio", true, components_dir),
        "cvrs" => install_python_component(id, "cvrs.py", "cvrs", false, components_dir),
        _ => failed(
            "此组件尚无可信的跨平台安装清单。",
            "已拒绝下载；请等待包含来源、版本和 SHA-256 的发布清单。",
        ),
    }
}

fn install_python_component(
    id: &str,
    script_name: &str,
    config_key: &str,
    install_requirements: bool,
    components_dir: &Path,
) -> OperationResult {
    let source = components_dir.join(id);
    if !source.join(script_name).is_file() {
        return failed("应用包缺少组件源码。", source.to_string_lossy());
    }
    let target = pi_agent_core::data_root().join("components").join(id);
    if let Err(error) = copy_directory(&source, &target) {
        return failed("复制组件失败。", error.to_string());
    }
    let Some(python) = find_python() else {
        return failed(
            "未找到 Python 3.11。",
            "请安装 Python 3.11，并确保 python3 或 python 可以启动。也可设置 PI_AGENT_PYTHON。",
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
    if let Ok(configured) = std::env::var("PI_AGENT_PYTHON") {
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
