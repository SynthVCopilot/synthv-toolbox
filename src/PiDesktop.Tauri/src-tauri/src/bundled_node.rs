use std::path::{Path, PathBuf};

pub fn node_binary_from_resource_dir(resource_dir: &Path) -> PathBuf {
    resource_dir.join("node").join(node_filename())
}

pub fn node_binary() -> Result<PathBuf, String> {
    let development = node_binary_from_resource_dir(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .as_path(),
    );
    if development.is_file() {
        return Ok(development);
    }
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位应用可执行文件：{error}"))?;
    let mut candidates = Vec::new();
    if let Some(directory) = executable.parent() {
        candidates.push(node_binary_from_resource_dir(&directory.join("resources")));
        candidates.push(node_binary_from_resource_dir(directory));
        if let Some(contents) = directory.parent() {
            candidates.push(node_binary_from_resource_dir(&contents.join("Resources")));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "当前应用包未包含受控 Node.js 运行时。".to_string())
}

fn node_filename() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}
