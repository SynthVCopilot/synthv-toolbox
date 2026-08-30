use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

const CATALOG_URL: &str = "https://models.dev/api.json";
const CATALOG_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);
const CATALOG_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeCatalogProvider {
    pub id: String,
    pub name: String,
    pub model_count: usize,
    pub package: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeCatalog {
    pub generated_at: u64,
    pub providers: Vec<OpenCodeCatalogProvider>,
}

#[derive(Clone)]
struct CacheEntry {
    checked_at: Instant,
    catalog: OpenCodeCatalog,
}

static CACHE: OnceLock<Mutex<Option<CacheEntry>>> = OnceLock::new();

pub fn catalog(force: bool) -> Result<OpenCodeCatalog, String> {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let previous = cache
        .lock()
        .map_err(|_| "OpenCode 目录缓存不可用。".to_string())?
        .clone();
    if !force {
        if let Some(entry) = &previous {
            if entry.checked_at.elapsed() < CATALOG_TTL {
                return Ok(entry.catalog.clone());
            }
        }
    }

    match fetch_catalog() {
        Ok(catalog) => {
            *cache
                .lock()
                .map_err(|_| "OpenCode 目录缓存不可用。".to_string())? = Some(CacheEntry {
                checked_at: Instant::now(),
                catalog: catalog.clone(),
            });
            Ok(catalog)
        }
        Err(_) if previous.is_some() => Ok(previous.expect("checked above").catalog),
        Err(error) => Err(error),
    }
}

fn fetch_catalog() -> Result<OpenCodeCatalog, String> {
    let agent = ureq::AgentBuilder::new().timeout(CATALOG_TIMEOUT).build();
    let response = agent
        .get(CATALOG_URL)
        .set("accept", "application/json")
        .call()
        .map_err(|error| format!("无法获取 OpenCode 提供商列表：{error}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((CATALOG_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 OpenCode 提供商列表：{error}"))?;
    if bytes.len() > CATALOG_LIMIT {
        return Err("OpenCode 提供商列表超过 8 MiB 限制。".to_string());
    }
    parse_catalog(&bytes)
}

fn parse_catalog(bytes: &[u8]) -> Result<OpenCodeCatalog, String> {
    let payload: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("OpenCode 提供商列表不是有效 JSON：{error}"))?;
    let entries = payload
        .as_object()
        .ok_or_else(|| "OpenCode 提供商列表格式无效。".to_string())?;
    let mut providers = entries
        .iter()
        .filter_map(|(id, raw)| {
            let entry = raw.as_object()?;
            let package = entry.get("npm")?.as_str()?.trim();
            let model_count = entry.get("models")?.as_object()?.len();
            if id.is_empty() || package.is_empty() || model_count == 0 {
                return None;
            }
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(id);
            Some(OpenCodeCatalogProvider {
                id: id.clone(),
                name: name.to_string(),
                model_count,
                package: package.to_string(),
            })
        })
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    if providers.is_empty() {
        return Err("OpenCode 提供商列表为空。".to_string());
    }
    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(OpenCodeCatalog {
        generated_at,
        providers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_compact_provider_view() {
        let catalog = parse_catalog(
            br#"{
                "anthropic":{"name":"Anthropic","npm":"@ai-sdk/anthropic","models":{"one":{},"two":{}}},
                "empty":{"name":"Empty","npm":"@ai-sdk/openai","models":{}},
                "invalid":{"models":{"one":{}}}
            }"#,
        )
        .unwrap();
        assert_eq!(catalog.providers.len(), 1);
        assert_eq!(catalog.providers[0].id, "anthropic");
        assert_eq!(catalog.providers[0].model_count, 2);
    }
}
