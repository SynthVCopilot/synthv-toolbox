use std::collections::HashSet;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::oauth::AiProviderId;

const CATALOG_URL: &str = "https://models.dev/api.json";
const CATALOG_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);
const CATALOG_LIMIT: usize = 8 * 1024 * 1024;
const FAILURE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeCatalogProvider {
    pub id: String,
    pub name: String,
    pub model_count: usize,
    pub package: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeCatalog {
    pub generated_at: u64,
    pub providers: Vec<OpenCodeCatalogProvider>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeCatalogSource {
    ModelsDev,
    BuiltInFallback,
}

#[derive(Debug, Clone)]
pub struct RuntimeModelCatalog {
    pub source: RuntimeCatalogSource,
    pub generated_at: u64,
    pub error: Option<String>,
    anthropic: Vec<String>,
    openai_codex: Vec<String>,
    workbuddy: Vec<String>,
    traecode: Vec<String>,
}

impl RuntimeModelCatalog {
    pub fn fallback(error: Option<String>) -> Self {
        Self {
            source: RuntimeCatalogSource::BuiltInFallback,
            generated_at: 0,
            error,
            anthropic: fallback_models(AiProviderId::Anthropic),
            openai_codex: fallback_models(AiProviderId::OpenaiCodex),
            workbuddy: Vec::new(),
            traecode: vec!["trae-account-default".to_string()],
        }
    }

    pub fn models_for(&self, provider: AiProviderId) -> &[String] {
        match provider {
            AiProviderId::Anthropic => &self.anthropic,
            AiProviderId::OpenaiCodex => &self.openai_codex,
            AiProviderId::Workbuddy => &self.workbuddy,
            AiProviderId::Traecode => &self.traecode,
        }
    }

    fn from_models_dev(catalog: &OpenCodeCatalog) -> Self {
        let anthropic = catalog_models(catalog, "anthropic", |model| model.starts_with("claude-"));
        let openai_codex = catalog_models(catalog, "openai", |model| {
            model.starts_with("gpt-5") && !model.ends_with("-chat-latest")
        });
        Self {
            source: RuntimeCatalogSource::ModelsDev,
            generated_at: catalog.generated_at,
            error: None,
            anthropic,
            openai_codex,
            workbuddy: workbuddy_models(catalog),
            traecode: vec!["trae-account-default".to_string()],
        }
    }
}

#[derive(Clone)]
struct CacheEntry {
    checked_at: Instant,
    catalog: OpenCodeCatalog,
}

static CACHE: OnceLock<Mutex<Option<CacheEntry>>> = OnceLock::new();
static LAST_FAILURE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();

pub fn cached_runtime_catalog() -> RuntimeModelCatalog {
    CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref().map(|entry| entry.catalog.clone()))
        .map(|catalog| RuntimeModelCatalog::from_models_dev(&catalog))
        .unwrap_or_else(|| RuntimeModelCatalog::fallback(None))
}

pub fn runtime_catalog(force: bool) -> RuntimeModelCatalog {
    let has_cached_catalog = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .is_some_and(|cache| cache.is_some());
    if !force && !has_cached_catalog {
        if let Ok(guard) = LAST_FAILURE.get_or_init(|| Mutex::new(None)).lock() {
            if let Some((checked_at, error)) = guard.as_ref() {
                if checked_at.elapsed() < FAILURE_TTL {
                    return RuntimeModelCatalog::fallback(Some(error.clone()));
                }
            }
        }
    }
    match catalog_with_status(force) {
        Ok((catalog, warning)) => {
            let mut runtime = RuntimeModelCatalog::from_models_dev(&catalog);
            runtime.error = warning;
            if runtime.error.is_none() {
                if let Ok(mut failure) = LAST_FAILURE.get_or_init(|| Mutex::new(None)).lock() {
                    *failure = None;
                }
            }
            runtime
        }
        Err(error) => {
            if let Ok(mut failure) = LAST_FAILURE.get_or_init(|| Mutex::new(None)).lock() {
                *failure = Some((Instant::now(), error.clone()));
            }
            RuntimeModelCatalog::fallback(Some(error))
        }
    }
}

pub fn catalog(force: bool) -> Result<OpenCodeCatalog, String> {
    catalog_with_status(force).map(|(catalog, _)| catalog)
}

fn catalog_with_status(force: bool) -> Result<(OpenCodeCatalog, Option<String>), String> {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let previous = cache
        .lock()
        .map_err(|_| "OpenCode 目录缓存不可用。".to_string())?
        .clone();
    if !force {
        if let Some(entry) = &previous {
            if entry.checked_at.elapsed() < CATALOG_TTL {
                return Ok((entry.catalog.clone(), None));
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
            Ok((catalog, None))
        }
        Err(error) if previous.is_some() => Ok((
            previous.expect("checked above").catalog,
            Some(format!("models.dev 刷新失败，继续使用上次目录：{error}")),
        )),
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

pub fn parse_catalog(bytes: &[u8]) -> Result<OpenCodeCatalog, String> {
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
            let models = parse_models(entry.get("models")?.as_object()?);
            if id.is_empty() || package.is_empty() || models.is_empty() {
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
                model_count: models.len(),
                package: package.to_string(),
                models,
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

pub fn runtime_catalog_from_bytes(bytes: &[u8]) -> Result<RuntimeModelCatalog, String> {
    parse_catalog(bytes).map(|catalog| RuntimeModelCatalog::from_models_dev(&catalog))
}

fn parse_models(models: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut parsed = models
        .iter()
        .filter_map(|(key, raw)| {
            let model = raw.as_object()?;
            if model
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| status.eq_ignore_ascii_case("deprecated"))
            {
                return None;
            }
            if !model
                .get("tool_call")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return None;
            }
            let outputs_text = model
                .get("modalities")
                .and_then(Value::as_object)
                .and_then(|modalities| modalities.get("output"))
                .and_then(Value::as_array)
                .is_some_and(|outputs| outputs.iter().any(|output| output == "text"));
            if !outputs_text {
                return None;
            }
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(key);
            if !model_id_is_safe(id) {
                return None;
            }
            let release_date = model
                .get("release_date")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some((id.to_string(), release_date.to_string()))
        })
        .collect::<Vec<_>>();
    parsed.sort_by(|left, right| {
        right.1.cmp(&left.1).then_with(|| {
            left.0
                .to_ascii_lowercase()
                .cmp(&right.0.to_ascii_lowercase())
        })
    });
    let mut seen = HashSet::new();
    parsed.retain(|(id, _)| seen.insert(id.clone()));
    parsed.into_iter().take(256).map(|(id, _)| id).collect()
}

fn model_id_is_safe(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

fn catalog_models(
    catalog: &OpenCodeCatalog,
    provider_id: &str,
    include: impl Fn(&str) -> bool,
) -> Vec<String> {
    catalog
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .map(|provider| {
            provider
                .models
                .iter()
                .filter(|model| include(model))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn workbuddy_models(catalog: &OpenCodeCatalog) -> Vec<String> {
    const VERIFIED: &[&str] = &[
        "glm-5.2", "glm-5.1", "glm-5v-turbo", "kimi-k2.7", "minimax-m3-pay", "hy3",
        "deepseek-v4-pro", "deepseek-v4-flash",
    ];
    let catalog_models = ["zhipuai", "deepseek", "tencent-tokenhub"]
        .into_iter()
        .flat_map(|provider| catalog_models(catalog, provider, |_| true))
        .collect::<HashSet<_>>();
    VERIFIED.iter().filter(|model| catalog_models.contains(**model)).map(|model| (*model).to_string()).collect()
}

fn fallback_models(provider: AiProviderId) -> Vec<String> {
    provider
        .fallback_model_options()
        .iter()
        .map(|model| (*model).to_string())
        .collect()
}
