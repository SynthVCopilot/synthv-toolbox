//! 统一数据根目录：`~/.SynthVcopilot/`。
//!
//! 所有组件的数据（模型、输出写入、配置、历史）一律放在这个根下，
//! 并通过 [`safe_join`] 硬禁止 `..` 穿透与越根写入。

use std::path::{Component, Path, PathBuf};

use super::error::{AgentError, Result};

/// 数据根：`~/.SynthVcopilot`（Windows 取 USERPROFILE，其余取 HOME）。
pub fn data_root() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".SynthVcopilot")
}

/// 模型数据目录：`~/.SynthVcopilot/models`。
pub fn models_dir() -> PathBuf {
    data_root().join("models")
}

/// 输出写入目录：`~/.SynthVcopilot/output`。
pub fn output_dir() -> PathBuf {
    data_root().join("output")
}

/// 会话历史目录：`~/.SynthVcopilot/history`。
pub fn history_dir() -> PathBuf {
    data_root().join("history")
}

/// 配置文件：`~/.SynthVcopilot/config.json`。
pub fn config_path() -> PathBuf {
    data_root().join("config.json")
}

/// 把（可能来自模型/外部的）相对路径安全地拼到 `root` 下。
///
/// 拒绝：`..` 组件（穿透）、绝对路径/盘符/根前缀。允许多级子目录。
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf> {
    let rel = Path::new(relative);
    let mut out = root.to_path_buf();
    for comp in rel.components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AgentError::new(format!(
                    "路径含 '..'，禁止穿透: {relative}"
                )))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AgentError::new(format!(
                    "禁止绝对路径，只接受根下相对路径: {relative}"
                )))
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_allows_plain_and_subdirs() {
        let root = Path::new("R");
        assert!(safe_join(root, "a.mid").is_ok());
        assert!(safe_join(root, "sub/dir/a.mid").is_ok());
        assert!(safe_join(root, "./a.mid").is_ok());
    }

    #[test]
    fn safe_join_rejects_traversal_and_absolute() {
        let root = Path::new("R");
        assert!(safe_join(root, "..").is_err());
        assert!(safe_join(root, "../evil.mid").is_err());
        assert!(safe_join(root, "a/../../evil.mid").is_err());
        assert!(safe_join(root, "..\\evil.mid").is_err());
        assert!(safe_join(root, "C:\\Windows\\evil.mid").is_err());
        assert!(safe_join(root, "\\evil.mid").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
    }

    #[test]
    fn data_root_under_home() {
        let root = data_root();
        assert!(root.ends_with(".SynthVcopilot"));
    }
}
