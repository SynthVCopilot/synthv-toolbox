use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::oauth::{self, AiProviderId, OAuthAccountMetadata, OAuthCredential};

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

static AGENT: OnceLock<ureq::Agent> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub reset_at: Option<i64>,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderUsageBalance {
    pub amount: f64,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCredentialUsage {
    pub provider_id: AiProviderId,
    pub credential_id: String,
    pub status: &'static str,
    pub plan: Option<String>,
    pub plan_multiplier: Option<f64>,
    pub billing_interval: Option<String>,
    pub subscription_renews_at: Option<i64>,
    pub subscription_expires_at: Option<i64>,
    pub metadata_error: Option<String>,
    pub windows: Vec<AiProviderUsageWindow>,
    pub balance: Option<AiProviderUsageBalance>,
    pub estimate: Option<Value>,
    pub fetched_at_utc: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderUsageAccount {
    pub provider: AiProviderId,
    pub channel: &'static str,
    pub credential_id: String,
    pub label: String,
    pub usage: AiCredentialUsage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderUsageSnapshot {
    pub queried_at: String,
    pub accounts: Vec<AiProviderUsageAccount>,
}

fn agent() -> &'static ureq::Agent {
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(10))
            .redirects(0)
            .https_only(true)
            .build()
    })
}

fn record(value: &Value) -> &Map<String, Value> {
    value.as_object().unwrap_or_else(|| static_empty_map())
}

fn static_empty_map() -> &'static Map<String, Value> {
    static EMPTY: OnceLock<Map<String, Value>> = OnceLock::new();
    EMPTY.get_or_init(Map::new)
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|item| match item {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    })
}

fn first_number(root: &Map<String, Value>, names: &[&str]) -> Option<f64> {
    names.iter().find_map(|name| number(root.get(*name)))
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_text(root: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| text(root.get(*name)))
}

fn timestamp(value: Option<&Value>) -> Option<i64> {
    if let Some(raw) = number(value) {
        if raw <= 0.0 || !raw.is_finite() {
            return None;
        }
        return Some(if raw < 10_000_000_000.0 {
            (raw * 1000.0) as i64
        } else {
            raw as i64
        });
    }
    value
        .and_then(Value::as_str)
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|date| date.timestamp_millis())
}

fn clamp_percent(value: Option<f64>) -> Option<f64> {
    value.map(|item| item.clamp(0.0, 100.0))
}

fn parse_window(id: &str, label: &str, value: Option<&Value>) -> Option<AiProviderUsageWindow> {
    let root = record(value?);
    let used_percent = clamp_percent(first_number(
        root,
        &[
            "used_percent",
            "usedPercent",
            "utilization",
            "used_percentage",
            "usedPercentage",
        ],
    ));
    let used = first_number(root, &["used", "consumed"]);
    let limit = first_number(root, &["limit", "max"]);
    let remaining = first_number(root, &["remaining", "remain"]);
    let reset_at = timestamp(
        root.get("reset_at")
            .or_else(|| root.get("resetAt"))
            .or_else(|| root.get("resets_at")),
    );
    if used_percent.is_none()
        && used.is_none()
        && limit.is_none()
        && remaining.is_none()
        && reset_at.is_none()
    {
        return None;
    }
    Some(AiProviderUsageWindow {
        id: id.to_string(),
        label: label.to_string(),
        used_percent,
        remaining_percent: used_percent.map(|value| 100.0 - value),
        reset_at,
        used,
        limit,
        remaining,
        unit: first_text(root, &["unit"]),
    })
}

fn json_response(response: ureq::Response) -> Result<Value, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取用量响应：{error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("用量响应超过 512 KiB 安全上限。".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|_| "用量响应不是有效 JSON。".to_string())
}

fn get_json(url: &str, headers: &[(&str, &str)]) -> Result<Value, String> {
    let mut request = agent().get(url).set("accept", "application/json");
    for (name, value) in headers {
        request = request.set(name, value);
    }
    request
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(code, _) => format!("用量请求失败（HTTP {code}）。"),
            ureq::Error::Transport(error) => format!("用量请求失败：{error}"),
        })
        .and_then(json_response)
}

fn parse_codex_usage(
    payload: Value,
) -> (
    Option<String>,
    Vec<AiProviderUsageWindow>,
    Option<AiProviderUsageBalance>,
    Option<f64>,
) {
    let root = record(&payload);
    let rate = record(
        root.get("rate_limit")
            .or_else(|| root.get("rateLimit"))
            .or_else(|| root.get("limits"))
            .unwrap_or(&Value::Null),
    );
    let mut windows = Vec::new();
    for (id, label) in [
        ("primary", "Primary window"),
        ("secondary", "Secondary window"),
    ] {
        if let Some(window) = parse_window(
            id,
            label,
            rate.get(&format!("{id}_window")).or_else(|| rate.get(id)),
        ) {
            windows.push(window);
        }
    }
    if let Some(additional) = root
        .get("additional_rate_limits")
        .or_else(|| root.get("additionalRateLimits"))
        .and_then(Value::as_array)
    {
        for item in additional {
            let entry = record(item);
            let label = first_text(
                entry,
                &[
                    "limit_name",
                    "limitName",
                    "metered_feature",
                    "meteredFeature",
                ],
            );
            let id = first_text(
                entry,
                &[
                    "metered_feature",
                    "meteredFeature",
                    "limit_name",
                    "limitName",
                ],
            );
            let rate = record(
                entry
                    .get("rate_limit")
                    .or_else(|| entry.get("rateLimit"))
                    .or_else(|| entry.get("limit"))
                    .unwrap_or(&Value::Null),
            );
            if let (Some(id), Some(label)) = (id, label) {
                if let Some(window) = parse_window(
                    &format!("{id}:primary"),
                    &format!("{label} · Primary window"),
                    rate.get("primary_window").or_else(|| rate.get("primary")),
                ) {
                    windows.push(window);
                }
                if let Some(window) = parse_window(
                    &format!("{id}:secondary"),
                    &format!("{label} · Secondary window"),
                    rate.get("secondary_window")
                        .or_else(|| rate.get("secondary")),
                ) {
                    windows.push(window);
                }
            }
        }
    }
    let credits = record(root.get("credits").unwrap_or(&Value::Null));
    let balance = first_number(root, &["credit_balance"])
        .or_else(|| first_number(credits, &["balance", "remaining"]));
    let plan = record(root.get("plan").unwrap_or(&Value::Null));
    let subscription = record(
        root.get("subscription")
            .or_else(|| root.get("subscription_details"))
            .unwrap_or(&Value::Null),
    );
    let plan_multiplier = first_number(
        root,
        &[
            "plan_multiplier",
            "planMultiplier",
            "usage_multiplier",
            "usageMultiplier",
            "codex_usage_multiplier",
            "codexUsageMultiplier",
        ],
    )
    .or_else(|| first_number(plan, &["multiplier", "usage_multiplier", "usageMultiplier"]))
    .or_else(|| {
        first_number(
            subscription,
            &[
                "plan_multiplier",
                "planMultiplier",
                "usage_multiplier",
                "usageMultiplier",
            ],
        )
    })
    .filter(|value| *value == 5.0 || *value == 20.0);
    (
        first_text(
            root,
            &[
                "plan_type",
                "planType",
                "subscription_type",
                "subscriptionType",
            ],
        ),
        windows,
        balance.map(|amount| AiProviderUsageBalance {
            amount,
            unit: "credits".to_string(),
        }),
        plan_multiplier,
    )
}

fn parse_anthropic_usage(payload: Value) -> (Option<String>, Vec<AiProviderUsageWindow>) {
    let root = record(&payload);
    let limits = record(
        root.get("rate_limits")
            .or_else(|| root.get("rateLimits"))
            .or_else(|| root.get("limits"))
            .unwrap_or(&Value::Null),
    );
    let mut windows = Vec::new();
    for (id, label) in [
        ("five_hour", "5 hours"),
        ("seven_day", "7 days"),
        ("seven_day_oauth_apps", "7 days · OAuth apps"),
        ("seven_day_opus", "7 days · Opus"),
        ("seven_day_sonnet", "7 days · Sonnet"),
    ] {
        if let Some(window) = parse_window(id, label, limits.get(id).or_else(|| root.get(id))) {
            windows.push(window);
        }
    }
    (
        first_text(
            root,
            &[
                "subscription_type",
                "subscriptionType",
                "plan_type",
                "planType",
            ],
        ),
        windows,
    )
}

fn normalized_plan(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_lowercase())
        .map(|value| value.strip_prefix("claude_").unwrap_or(&value).to_string())
}

fn query_anthropic(credential: &OAuthCredential) -> Result<AiCredentialUsage, String> {
    let authorization = format!("Bearer {}", credential.access);
    let headers = [
        ("authorization", authorization.as_str()),
        ("anthropic-beta", "oauth-2025-04-20"),
    ];
    let (usage_plan, windows) = parse_anthropic_usage(get_json(ANTHROPIC_USAGE_URL, &headers)?);
    let mut plan = normalized_plan(usage_plan);
    let mut billing_interval = None;
    let mut renews_at = None;
    let mut expires_at = None;
    let mut metadata_error = None;
    if let Ok(profile) = get_json(ANTHROPIC_PROFILE_URL, &headers) {
        let profile_root = record(&profile);
        let organization = record(
            profile_root
                .get("organization")
                .or_else(|| profile_root.get("org"))
                .unwrap_or(&Value::Null),
        );
        let organization_id = first_text(
            profile_root,
            &["organization_id", "organizationId", "org_id"],
        )
        .or_else(|| first_text(organization, &["id", "uuid"]));
        plan = normalized_plan(
            first_text(profile_root, &["organization_type", "organizationType"])
                .or_else(|| first_text(organization, &["type", "organization_type"])),
        )
        .or(plan);
        if let Some(id) = organization_id {
            let encoded_id =
                url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>();
            let details_url = format!(
                "https://api.anthropic.com/api/organizations/{encoded_id}/subscription_details"
            );
            match get_json(&details_url, &headers) {
                Ok(details) => {
                    let root = record(&details);
                    let subscription = record(
                        root.get("subscription")
                            .or_else(|| root.get("subscription_details"))
                            .or_else(|| root.get("billing"))
                            .unwrap_or(&Value::Null),
                    );
                    billing_interval = first_text(
                        subscription,
                        &["billing_interval", "billingInterval", "interval"],
                    )
                    .or_else(|| {
                        first_text(root, &["billing_interval", "billingInterval", "interval"])
                    });
                    renews_at = timestamp(
                        subscription
                            .get("next_renewal_at")
                            .or_else(|| subscription.get("next_renewal_date"))
                            .or_else(|| subscription.get("next_invoice_date"))
                            .or_else(|| root.get("next_renewal_at"))
                            .or_else(|| root.get("next_renewal_date"))
                            .or_else(|| root.get("next_invoice_date")),
                    );
                    expires_at = timestamp(
                        subscription
                            .get("expires_at")
                            .or_else(|| subscription.get("ends_at"))
                            .or_else(|| subscription.get("cancel_at"))
                            .or_else(|| root.get("expires_at"))
                            .or_else(|| root.get("ends_at"))
                            .or_else(|| root.get("cancel_at")),
                    );
                }
                Err(error) => metadata_error = Some(error),
            }
        }
    }
    Ok(AiCredentialUsage {
        provider_id: AiProviderId::Anthropic,
        credential_id: String::new(),
        status: "ok",
        plan,
        plan_multiplier: None,
        billing_interval,
        subscription_renews_at: renews_at,
        subscription_expires_at: expires_at,
        metadata_error,
        windows,
        balance: None,
        estimate: None,
        fetched_at_utc: Utc::now().to_rfc3339(),
        error: None,
    })
}

fn query_codex(credential: &OAuthCredential) -> Result<AiCredentialUsage, String> {
    let authorization = format!("Bearer {}", credential.access);
    let headers = [
        ("authorization", authorization.as_str()),
        (
            "ChatGPT-Account-Id",
            credential.account_id.as_deref().unwrap_or(""),
        ),
    ];
    let (plan, windows, balance, plan_multiplier) =
        parse_codex_usage(get_json(CODEX_USAGE_URL, &headers)?);
    Ok(AiCredentialUsage {
        provider_id: AiProviderId::OpenaiCodex,
        credential_id: String::new(),
        status: "ok",
        plan,
        plan_multiplier,
        billing_interval: None,
        subscription_renews_at: None,
        subscription_expires_at: None,
        metadata_error: None,
        windows,
        balance,
        estimate: None,
        fetched_at_utc: Utc::now().to_rfc3339(),
        error: None,
    })
}

fn error_usage(provider: AiProviderId, credential_id: &str, error: String) -> AiCredentialUsage {
    AiCredentialUsage {
        provider_id: provider,
        credential_id: credential_id.to_string(),
        status: "error",
        plan: None,
        plan_multiplier: None,
        billing_interval: None,
        subscription_renews_at: None,
        subscription_expires_at: None,
        metadata_error: None,
        windows: Vec::new(),
        balance: None,
        estimate: None,
        fetched_at_utc: Utc::now().to_rfc3339(),
        error: Some(error),
    }
}

pub fn query_accounts(accounts: &[OAuthAccountMetadata]) -> AiProviderUsageSnapshot {
    let mut result = Vec::new();
    for account in accounts.iter().filter(|account| {
        account.enabled
            && matches!(
                account.provider,
                AiProviderId::Anthropic | AiProviderId::OpenaiCodex
            )
    }) {
        let usage = match oauth::load_ready_credential(account) {
            Ok(credential) => {
                let result = match account.provider {
                    AiProviderId::Anthropic => query_anthropic(&credential),
                    AiProviderId::OpenaiCodex => query_codex(&credential),
                    _ => unreachable!(),
                };
                match result {
                    Ok(mut usage) => {
                        usage.credential_id = account.id.clone();
                        usage
                    }
                    Err(error) => error_usage(account.provider, &account.id, error),
                }
            }
            Err(error) => error_usage(account.provider, &account.id, error),
        };
        result.push(AiProviderUsageAccount {
            provider: account.provider,
            channel: "oauth",
            credential_id: account.id.clone(),
            label: account.label.clone(),
            usage,
        });
    }
    AiProviderUsageSnapshot {
        queried_at: Utc::now().to_rfc3339(),
        accounts: result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_usage_keeps_windows_and_credit_balance() {
        let (plan, windows, balance, multiplier) = parse_codex_usage(serde_json::json!({
            "plan_type": "pro",
            "rate_limit": { "primary_window": { "used_percent": 22.125, "reset_at": 2_000_000_000 } },
            "credits": { "balance": 12.5 },
            "plan_multiplier": 20,
        }));
        assert_eq!(plan.as_deref(), Some("pro"));
        assert_eq!(windows[0].used_percent, Some(22.125));
        assert_eq!(windows[0].remaining_percent, Some(77.875));
        assert_eq!(windows[0].reset_at, Some(2_000_000_000_000));
        assert_eq!(balance.unwrap().amount, 12.5);
        assert_eq!(multiplier, Some(20.0));
    }

    #[test]
    fn anthropic_usage_accepts_nested_rate_limits() {
        let (plan, windows) = parse_anthropic_usage(serde_json::json!({
            "subscription_type": "max",
            "rate_limits": { "five_hour": { "utilization": 31.5, "resets_at": "2030-02-03T04:05:06Z" } },
        }));
        assert_eq!(plan.as_deref(), Some("max"));
        assert_eq!(windows[0].label, "5 hours");
        assert_eq!(windows[0].remaining_percent, Some(68.5));
        assert_eq!(windows[0].reset_at, Some(1_896_321_906_000));
    }
}
