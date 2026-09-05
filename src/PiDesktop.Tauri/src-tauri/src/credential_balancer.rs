use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};

pub use crate::config::AiAuthMethod;
pub use crate::config::AiLoadStrategy;
pub use crate::oauth::AiProviderId;

const TRANSIENT_BASE_MS: i64 = 15_000;
const TRANSIENT_MAX_MS: i64 = 120_000;
const RATE_LIMIT_BASE_MS: i64 = 60_000;
const RATE_LIMIT_MAX_MS: i64 = 300_000;

#[derive(Debug, Clone)]
pub struct CredentialRoute {
    pub id: String,
    pub provider: AiProviderId,
    pub auth_method: AiAuthMethod,
    pub models: Vec<String>,
    pub weight: u8,
    pub strategy: AiLoadStrategy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialCandidate {
    pub id: String,
    pub auth_method: AiAuthMethod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Health {
    Healthy,
    Cooling { until_ms: i64 },
    PermanentlyFailed,
}

#[derive(Debug, Clone, Copy)]
struct CredentialState {
    health: Health,
    failure_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthSnapshot {
    pub healthy: bool,
    pub cooldown_until_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
pub enum FailureKind {
    Unauthorized,
    RateLimited,
    Server,
    Transport,
}

pub struct CredentialBalancer {
    routes: HashMap<String, CredentialRoute>,
    states: HashMap<String, CredentialState>,
    cursors: HashMap<String, usize>,
}

impl CredentialBalancer {
    pub fn new(routes: impl IntoIterator<Item = CredentialRoute>) -> Self {
        let mut balancer = Self {
            routes: HashMap::new(),
            states: HashMap::new(),
            cursors: HashMap::new(),
        };
        for route in routes {
            balancer.upsert(route);
        }
        balancer
    }

    pub fn upsert(&mut self, route: CredentialRoute) {
        let key = route_key(route.auth_method, &route.id);
        self.routes.insert(key.clone(), route);
        self.states.insert(
            key,
            CredentialState {
                health: Health::Healthy,
                failure_count: 0,
            },
        );
    }

    pub fn sync_route(&mut self, route: CredentialRoute) {
        let key = route_key(route.auth_method, &route.id);
        self.routes.insert(key.clone(), route);
        self.states.entry(key).or_insert(CredentialState {
            health: Health::Healthy,
            failure_count: 0,
        });
        self.cursors.clear();
    }

    pub fn remove(&mut self, auth_method: AiAuthMethod, id: &str) {
        let key = route_key(auth_method, id);
        self.routes.remove(&key);
        self.states.remove(&key);
        self.cursors.clear();
    }

    pub fn candidates(&mut self, provider: AiProviderId, model: &str) -> Vec<CredentialCandidate> {
        let mut eligible = self
            .routes
            .iter()
            .filter(|(key, route)| {
                route.provider == provider
                    && route.models.iter().any(|candidate| candidate == model)
                    && self.is_eligible(key)
            })
            .map(|(key, route)| {
                (
                    key.clone(),
                    CredentialCandidate {
                        id: route.id.clone(),
                        auth_method: route.auth_method,
                    },
                )
            })
            .collect::<Vec<_>>();
        eligible.sort_by(|left, right| left.0.cmp(&right.0));
        if eligible.is_empty() {
            return Vec::new();
        }
        let route_strategy = self.routes.get(&eligible[0].0).map(|route| route.strategy).unwrap_or(AiLoadStrategy::RoundRobin);
        if route_strategy == AiLoadStrategy::Failover {
            return eligible.into_iter().map(|(_, candidate)| candidate).collect();
        }
        if route_strategy == AiLoadStrategy::WeightedRoundRobin {
            let mut weighted = eligible.iter().flat_map(|(key, candidate)| {
                let weight = self.routes.get(key).map(|route| route.weight.clamp(1, 100)).unwrap_or(1);
                vec![candidate.clone(); usize::from(weight)]
            }).collect::<Vec<_>>();
            let cursor_key = format!("{}\u{0000}{model}", provider.as_str());
            let start = self.cursors.get(&cursor_key).copied().unwrap_or_default() % weighted.len();
            self.cursors.insert(cursor_key, (start + 1) % weighted.len());
            weighted.rotate_left(start);
            return weighted;
        }
        let key = format!("{}\u{0000}{model}", provider.as_str());
        let start = self.cursors.get(&key).copied().unwrap_or_default() % eligible.len();
        self.cursors.insert(key, (start + 1) % eligible.len());
        eligible.rotate_left(start);
        eligible
            .into_iter()
            .map(|(_, candidate)| candidate)
            .collect()
    }

    pub fn record_success(&mut self, auth_method: AiAuthMethod, id: &str) {
        if let Some(state) = self.states.get_mut(&route_key(auth_method, id)) {
            if state.health == Health::PermanentlyFailed {
                return;
            }
            state.health = Health::Healthy;
            state.failure_count = 0;
        }
    }

    pub fn record_failure(&mut self, auth_method: AiAuthMethod, id: &str, kind: FailureKind) {
        let Some(state) = self.states.get_mut(&route_key(auth_method, id)) else {
            return;
        };
        if state.health == Health::PermanentlyFailed {
            return;
        }
        state.failure_count = state.failure_count.saturating_add(1);
        if matches!(kind, FailureKind::Unauthorized) {
            state.health = Health::PermanentlyFailed;
            return;
        }
        let (base, maximum) = if matches!(kind, FailureKind::RateLimited) {
            (RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS)
        } else {
            (TRANSIENT_BASE_MS, TRANSIENT_MAX_MS)
        };
        let exponent = i64::from(state.failure_count.saturating_sub(1).min(5));
        let duration = base
            .saturating_mul(2_i64.saturating_pow(exponent as u32))
            .min(maximum);
        state.health = Health::Cooling {
            until_ms: now_ms().saturating_add(duration),
        };
    }

    pub fn health(&self, auth_method: AiAuthMethod, id: &str) -> HealthSnapshot {
        match self
            .states
            .get(&route_key(auth_method, id))
            .map(|state| state.health)
        {
            Some(Health::PermanentlyFailed) => HealthSnapshot {
                healthy: false,
                cooldown_until_ms: None,
            },
            Some(Health::Cooling { until_ms }) if until_ms > now_ms() => HealthSnapshot {
                healthy: false,
                cooldown_until_ms: Some(until_ms),
            },
            Some(Health::Healthy) | Some(Health::Cooling { .. }) | None => HealthSnapshot {
                healthy: true,
                cooldown_until_ms: None,
            },
        }
    }

    fn is_eligible(&self, key: &str) -> bool {
        match self.states.get(key).map(|state| state.health) {
            Some(Health::PermanentlyFailed) => false,
            Some(Health::Cooling { until_ms }) => until_ms <= now_ms(),
            Some(Health::Healthy) | None => true,
        }
    }
}

fn route_key(auth_method: AiAuthMethod, id: &str) -> String {
    format!("{auth_method:?}\u{0000}{id}")
}

pub fn cooldown_until_utc(milliseconds: Option<i64>) -> Option<String> {
    milliseconds
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .map(|value| value.to_rfc3339())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(id: &str, auth_method: AiAuthMethod, models: &[&str]) -> CredentialRoute {
        CredentialRoute {
            id: id.to_string(),
            provider: AiProviderId::Anthropic,
            auth_method,
            models: models.iter().map(|value| (*value).to_string()).collect(),
            weight: 1,
            strategy: AiLoadStrategy::RoundRobin,
        }
    }

    #[test]
    fn mixed_auth_credentials_share_one_fair_route_cursor() {
        let mut balancer = CredentialBalancer::new([
            route("oauth", AiAuthMethod::OAuth, &["model"]),
            route("key", AiAuthMethod::ApiKey, &["model"]),
            route("other", AiAuthMethod::ApiKey, &["else"]),
        ]);
        assert_eq!(
            balancer.candidates(AiProviderId::Anthropic, "model"),
            [
                CredentialCandidate {
                    id: "key".to_string(),
                    auth_method: AiAuthMethod::ApiKey
                },
                CredentialCandidate {
                    id: "oauth".to_string(),
                    auth_method: AiAuthMethod::OAuth
                }
            ]
        );
        assert_eq!(
            balancer.candidates(AiProviderId::Anthropic, "model"),
            [
                CredentialCandidate {
                    id: "oauth".to_string(),
                    auth_method: AiAuthMethod::OAuth
                },
                CredentialCandidate {
                    id: "key".to_string(),
                    auth_method: AiAuthMethod::ApiKey
                }
            ]
        );
    }

    #[test]
    fn transient_cooldown_and_permanent_failure_recover_on_success() {
        let mut balancer =
            CredentialBalancer::new([route("key", AiAuthMethod::ApiKey, &["model"])]);
        balancer.record_failure(AiAuthMethod::ApiKey, "key", FailureKind::Server);
        assert!(balancer
            .candidates(AiProviderId::Anthropic, "model")
            .is_empty());
        balancer.record_failure(AiAuthMethod::ApiKey, "key", FailureKind::Unauthorized);
        assert!(balancer
            .candidates(AiProviderId::Anthropic, "model")
            .is_empty());
        balancer.record_failure(AiAuthMethod::ApiKey, "key", FailureKind::Server);
        assert_eq!(
            balancer.health(AiAuthMethod::ApiKey, "key"),
            HealthSnapshot {
                healthy: false,
                cooldown_until_ms: None,
            }
        );
        balancer.sync_route(route("key", AiAuthMethod::ApiKey, &["model", "model-2"]));
        assert!(balancer
            .candidates(AiProviderId::Anthropic, "model-2")
            .is_empty());
        balancer.upsert(route("key", AiAuthMethod::ApiKey, &["model"]));
        assert_eq!(
            balancer.candidates(AiProviderId::Anthropic, "model")[0].id,
            "key"
        );
    }
}
