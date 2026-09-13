use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::http;

const MAX_PLUGIN_ASSET_BYTES: u64 = 16 * 1024 * 1024;

pub fn serve(request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    if !matches!(request.method(), &http::Method::GET | &http::Method::HEAD) {
        return response(
            http::StatusCode::METHOD_NOT_ALLOWED,
            "text/plain",
            Vec::new(),
        );
    }
    let uri = request.uri();
    if uri.query().is_some()
        || !matches!(
            uri.authority().map(|value| value.as_str()),
            Some("localhost" | "toolbox-plugin.localhost")
        )
    {
        return response(http::StatusCode::BAD_REQUEST, "text/plain", Vec::new());
    }

    let Some(relative) = safe_relative_path(uri.path()) else {
        return response(http::StatusCode::BAD_REQUEST, "text/plain", Vec::new());
    };
    let root = crate::agent::data_root().join("plugins");
    let Some(plugin_id) = relative.components().next().and_then(component_text) else {
        return response(http::StatusCode::BAD_REQUEST, "text/plain", Vec::new());
    };
    let plugin_root = root.join(plugin_id);
    let candidate = root.join(&relative);
    let (Ok(plugin_root), Ok(candidate)) = (plugin_root.canonicalize(), candidate.canonicalize())
    else {
        return response(http::StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    if !candidate.starts_with(&plugin_root) || !candidate.is_file() {
        return response(http::StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }
    let Ok(metadata) = candidate.metadata() else {
        return response(http::StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    if metadata.len() > MAX_PLUGIN_ASSET_BYTES {
        return response(
            http::StatusCode::PAYLOAD_TOO_LARGE,
            "text/plain",
            Vec::new(),
        );
    }
    let body = if request.method() == http::Method::HEAD {
        Vec::new()
    } else {
        match fs::read(&candidate) {
            Ok(bytes) => bytes,
            Err(_) => return response(http::StatusCode::NOT_FOUND, "text/plain", Vec::new()),
        }
    };
    response(http::StatusCode::OK, mime_type(&candidate), body)
}

fn safe_relative_path(path: &str) -> Option<PathBuf> {
    if path.contains('%') || path.contains('\\') {
        return None;
    }
    let relative = Path::new(path.strip_prefix('/')?);
    if relative.components().count() < 2
        || relative.components().any(|component| {
            !matches!(component, Component::Normal(_))
                || component_text(component).is_none_or(|segment| {
                    segment.is_empty()
                        || !segment
                            .chars()
                            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
                })
        })
    {
        return None;
    }
    Some(relative.to_path_buf())
}

fn component_text(component: Component<'_>) -> Option<&str> {
    match component {
        Component::Normal(value) => value.to_str(),
        _ => None,
    }
}

fn mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn response(
    status: http::StatusCode,
    content_type: &str,
    body: Vec<u8>,
) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, content_type)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .body(body)
        .unwrap_or_else(|_| http::Response::new(Vec::new()))
}
