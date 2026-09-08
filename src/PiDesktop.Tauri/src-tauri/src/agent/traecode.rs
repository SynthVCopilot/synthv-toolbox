use super::{AgentError, AgentProvider, AgentStep, ChatMessage, Result, Role, ToolDefinition};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit,
};
use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::IntoResponse,
    routing::any,
    Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    elliptic_curve::rand_core::{OsRng, RngCore},
    pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey, LineEnding},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroize;

const CLIENT_ID: &str = "ono9krqynydwx5";
const VERSION: &str = "3.5.81";
const EXCHANGE: &str = "/trae/api/v3/oauth/ExchangeToken";
const HOSTS: [&str; 3] = [
    "https://growsg-normal.trae.ai",
    "https://grow-normal.traeapi.us",
    "https://grow-normal.trae.ai",
];
const MAX_RESPONSE: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraeDevice {
    pub device_id: String,
    pub machine_id: String,
    pub private_key_pem: String,
    pub public_key_pem: String,
}
impl Drop for TraeDevice {
    fn drop(&mut self) {
        self.private_key_pem.zeroize();
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraeCredential {
    pub access: String,
    pub refresh: String,
    pub expires: i64,
    pub refresh_expires: i64,
    pub host: String,
    pub client_id: String,
    pub device: TraeDevice,
    pub account_id: String,
    pub label: String,
    pub store_country: String,
    pub models: Vec<String>,
}
impl Drop for TraeCredential {
    fn drop(&mut self) {
        self.access.zeroize();
        self.refresh.zeroize();
    }
}
#[derive(Clone)]
pub struct TraeCodeConfig {
    pub model: String,
    pub account_id: String,
    pub timeout_secs: u64,
}
impl TraeCodeConfig {
    pub fn new(model: impl Into<String>, account_id: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            account_id: account_id.into(),
            timeout_secs: 120,
        }
    }
}
pub struct TraeCodeProvider {
    config: TraeCodeConfig,
}
impl TraeCodeProvider {
    pub fn new(config: TraeCodeConfig) -> Self {
        Self { config }
    }
}
fn error(message: &str) -> AgentError {
    AgentError::new(message)
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| error("Trae HTTP client unavailable."))
}
fn trusted_host(host: &str) -> Result<&str> {
    if HOSTS.contains(&host) {
        Ok(host)
    } else {
        Err(error("Trae credential host is not trusted."))
    }
}
fn text(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error("Trae returned an incomplete response."))
}
fn validate(credential: &TraeCredential) -> Result<SigningKey> {
    trusted_host(&credential.host)?;
    if credential.client_id.is_empty()
        || credential.access.is_empty()
        || credential.refresh.is_empty()
        || credential.device.device_id.is_empty()
        || credential.device.machine_id.is_empty()
    {
        return Err(error("Trae credential binding is incomplete."));
    }
    let key = SigningKey::from_pkcs8_pem(&credential.device.private_key_pem)
        .map_err(|_| error("Trae device key is invalid."))?;
    let pem = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(|_| error("Trae device key is invalid."))?;
    if pem != credential.device.public_key_pem {
        return Err(error("Trae device public key does not match."));
    }
    Ok(key)
}
fn device() -> Result<TraeDevice> {
    let key = SigningKey::random(&mut OsRng);
    Ok(TraeDevice {
        device_id: Uuid::new_v4().to_string(),
        machine_id: Uuid::new_v4().to_string(),
        private_key_pem: key
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|_| error("Trae device key unavailable."))?
            .to_string(),
        public_key_pem: key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .map_err(|_| error("Trae device key unavailable."))?,
    })
}
fn device_info(device: &TraeDevice) -> Value {
    json!({"DeviceID":device.device_id,"MachineID":device.machine_id,"PlatformCode":"IDE_PC","DeviceType":"PC","DeviceName":"","DeviceModel":"","ClientVersion":VERSION,"DevicePublicKey":device.public_key_pem,"DeviceBrand":"","DeviceCPU":"","OSInfo":"","OSVersion":""})
}
async fn checked(response: reqwest::Response) -> Result<reqwest::Response> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(AgentError::http(
            response.status().as_u16(),
            "Trae service rejected the request.",
        ))
    }
}
async fn bounded_json(response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| error("Trae response was interrupted."))?;
        if bytes.len() + part.len() > MAX_RESPONSE {
            return Err(error("Trae response exceeds size limit."));
        }
        bytes.extend_from_slice(&part);
    }
    serde_json::from_slice(&bytes).map_err(|_| error("Trae returned invalid JSON."))
}
async fn post(
    client: &reqwest::Client,
    host: &str,
    path: &str,
    access: &str,
    body: Value,
) -> Result<Value> {
    let response = client
        .post(format!("{}{path}", trusted_host(host)?))
        .header("x-cloudide-token", access)
        .json(&body)
        .send()
        .await
        .map_err(|_| AgentError::transport("Trae service request failed."))?;
    let envelope = bounded_json(checked(response).await?).await?;
    if envelope
        .pointer("/ResponseMetadata/Error")
        .is_some_and(|v| !v.is_null())
    {
        return Err(error("Trae rejected the authorization."));
    }
    envelope
        .get("Result")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| error("Trae returned an incomplete response."))
}
fn expiry(value: &Value, duration: Option<&Value>) -> Result<i64> {
    let time = value.as_i64().or_else(|| {
        value.as_str().and_then(|s| {
            s.parse().ok().or_else(|| {
                chrono::DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.timestamp_millis())
            })
        })
    });
    time.filter(|time| *time > now())
        .or_else(|| {
            duration
                .and_then(Value::as_i64)
                .filter(|d| *d > 0)
                .and_then(|d| now().checked_add(d))
        })
        .ok_or_else(|| error("Trae returned an expired credential."))
}
fn update_tokens(credential: &mut TraeCredential, value: &Value) -> Result<()> {
    let access = text(value, "Token")?;
    let refresh = text(value, "RefreshToken")?;
    let expires = expiry(&value["TokenExpireAt"], value.get("TokenExpireDuration"))?;
    let refresh_expires = expiry(&value["RefreshExpireAt"], None)?;
    credential.access = access;
    credential.refresh = refresh;
    credential.expires = expires;
    credential.refresh_expires = refresh_expires;
    Ok(())
}
fn refresh_body(credential: &TraeCredential, timestamp: i64, nonce: &str) -> Result<Value> {
    let key = validate(credential)?;
    let proof = format!(
        "POST\n{EXCHANGE}\n{}\n{}\n{timestamp}\n{nonce}",
        credential.client_id, credential.refresh
    );
    let signature: Signature = key.sign(proof.as_bytes());
    Ok(
        json!({"ClientID":credential.client_id,"ClientSecret":"","RefreshToken":credential.refresh,"DeviceInfo":device_info(&credential.device),"DeviceProof":{"Signature":STANDARD.encode(signature.to_der().as_bytes()),"Timestamp":timestamp,"Nonce":nonce},"IDEVersion":VERSION}),
    )
}
async fn refresh(client: &reqwest::Client, credential: &mut TraeCredential) -> Result<()> {
    if credential.refresh_expires <= now() {
        return Err(error(
            "Trae refresh credential has expired; reconnect the account.",
        ));
    }
    let result = post(
        client,
        &credential.host,
        EXCHANGE,
        &credential.access,
        refresh_body(credential, now() / 1000, &hex(&random::<16>()))?,
    )
    .await?;
    update_tokens(credential, &result)
}
fn inference_host(credential: &TraeCredential) -> Result<&'static str> {
    let country = &credential.store_country;
    if country.len() != 2 || !country.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(error("Trae account deployment country is missing."));
    }
    Ok(
        if ["AS", "GU", "MP", "PR", "UM", "US", "VI"].contains(&country.as_str()) {
            "https://core-normal.traeapi.us"
        } else {
            "https://coresg-normal.trae.ai"
        },
    )
}
fn api_request(
    client: &reqwest::Client,
    credential: &TraeCredential,
    path: &str,
    method: reqwest::Method,
) -> Result<reqwest::RequestBuilder> {
    validate(credential)?;
    if credential.expires <= now() {
        return Err(error("Trae access credential has expired."));
    }
    Ok(client
        .request(method, format!("{}{path}", inference_host(credential)?))
        .header("Content-Type", "application/json")
        .header("X-App-Id", "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8")
        .header(
            "Authorization",
            format!("Cloud-IDE-JWT {}", credential.access),
        )
        .header("get-svc", "1")
        .header("x-ide-version-code", "20260212")
        .header("X-Device-Id", &credential.device.device_id)
        .header("X-Machine-Id", &credential.device.machine_id))
}
async fn models(client: &reqwest::Client, credential: &TraeCredential) -> Result<Vec<String>> {
    let response = api_request(
        client,
        credential,
        "/api/ide/v1/model_list?type=llm_raw_chat",
        reqwest::Method::GET,
    )?
    .send()
    .await
    .map_err(|_| AgentError::transport("Trae model discovery failed."))?;
    let value = bounded_json(checked(response).await?).await?;
    if value.get("code").is_some_and(|v| v != &json!(0)) {
        return Err(error("Trae model discovery was rejected."));
    }
    let values = value
        .get("model_configs")
        .and_then(Value::as_array)
        .ok_or_else(|| error("Trae returned an invalid model list."))?;
    let mut names = values
        .iter()
        .map(|v| text(v, "name"))
        .collect::<Result<Vec<_>>>()?;
    names.sort();
    names.dedup();
    Ok(names)
}

type CallbackSender = tokio::sync::oneshot::Sender<Result<(String, String)>>;

struct CallbackState {
    authority: String,
    trace: String,
    sender: Mutex<Option<CallbackSender>>,
}
fn callback_value(
    method: &str,
    authority: &str,
    target: &str,
    state: &CallbackState,
) -> Result<Option<(String, String)>> {
    if method != "GET"
        || authority != state.authority
        || target.len() > 32_768
        || !target.starts_with("/authorize?")
    {
        return Err(error("Invalid callback route."));
    }
    let url = Url::parse(&format!("http://{}{target}", state.authority))
        .map_err(|_| error("Invalid callback URL."))?;
    if url.path() != "/authorize" || url.host_str() != Some("127.0.0.1") {
        return Err(error("Invalid callback route."));
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let one = |key: &str| -> Option<String> {
        let found: Vec<_> = pairs.iter().filter(|(k, _)| k == key).collect();
        if found.len() == 1 {
            Some(found[0].1.to_string())
        } else {
            None
        }
    };
    if one("loginTraceID").as_deref() != Some(&state.trace) {
        return Err(error("Invalid callback correlation."));
    }
    if pairs.iter().any(|(k, _)| k == "error_code") {
        return Ok(None);
    }
    let info: Value = serde_json::from_str(
        &one("authCodeInfo").ok_or_else(|| error("Invalid authorization response."))?,
    )
    .map_err(|_| error("Invalid authorization response."))?;
    let tag = one("userTag")
        .filter(|t| t == "row" || t == "usttp")
        .ok_or_else(|| error("Invalid authorization response."))?;
    if one("scope").as_deref() != Some("trae") {
        return Err(error("Invalid authorization scope."));
    }
    Ok(Some((text(&info, "AuthCode")?, tag)))
}
async fn callback(State(state): State<Arc<CallbackState>>, request: Request) -> impl IntoResponse {
    let host = request
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let target = request.uri().to_string();
    let result = callback_value(request.method().as_str(), host, &target, &state);
    let status = match result {
        Ok(value) => {
            let mut sender = state.sender.lock().unwrap();
            if let Some(sender) = sender.take() {
                let ok = value.is_some();
                let _ = sender
                    .send(value.ok_or_else(|| error("Trae browser authorization was rejected.")));
                if ok {
                    StatusCode::OK
                } else {
                    StatusCode::BAD_REQUEST
                }
            } else {
                StatusCode::GONE
            }
        }
        Err(_) => StatusCode::BAD_REQUEST,
    };
    (
        status,
        [
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
            ("content-security-policy", "default-src 'none'"),
        ],
        "Authorization response received. Return to the application.",
    )
}
fn run<T>(
    future: impl Future<Output = Result<T>>,
    cancelled: Option<&AtomicBool>,
    timeout: Duration,
) -> Result<T> {
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| error("Trae runtime unavailable."))?.block_on(async {
        tokio::select! {
            result=future => result,
            _=tokio::time::sleep(timeout) => Err(error("Trae operation timed out.")),
            _=async { loop { if cancelled.is_some_and(|c| c.load(Ordering::Relaxed)) { break; } tokio::time::sleep(Duration::from_millis(50)).await; } } => Err(error("Trae operation was cancelled.")),
        }
    })
}
pub fn authorize(
    cancelled: Option<&AtomicBool>,
    open: impl FnOnce(&str) -> std::result::Result<(), String>,
) -> Result<TraeCredential> {
    if cancelled.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Err(error("Trae operation was cancelled."));
    }
    run(
        async {
            let binding = device()?;
            let trace = Uuid::new_v4().to_string();
            let verifier = URL_SAFE_NO_PAD.encode(random::<48>());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|_| error("Trae callback listener unavailable."))?;
            let authority = listener
                .local_addr()
                .map_err(|_| error("Trae callback listener unavailable."))?
                .to_string();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let state = Arc::new(CallbackState {
                authority: authority.clone(),
                trace: trace.clone(),
                sender: Mutex::new(Some(sender)),
            });
            let app = Router::new().fallback(any(callback)).with_state(state);
            let server = tokio::spawn(async move { axum::serve(listener, app).await });
            let mut url = Url::parse("https://www.trae.ai/authorization").unwrap();
            url.query_pairs_mut().extend_pairs(&[
                ("login_version", "1"),
                ("auth_from", "trae"),
                ("login_channel", "native_ide"),
                ("plugin_version", "2.3.61406"),
                ("auth_type", "local"),
                ("client_id", CLIENT_ID),
                ("redirect", "0"),
                ("login_trace_id", &trace),
                (
                    "auth_callback_url",
                    &format!("http://{authority}/authorize"),
                ),
                ("machine_id", &binding.machine_id),
                ("device_id", &binding.device_id),
                ("x_device_id", &binding.device_id),
                ("x_machine_id", &binding.machine_id),
                ("x_app_version", VERSION),
                ("x_app_type", "stable"),
                (
                    "code_challenge",
                    &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
                ),
                ("code_challenge_method", "S256"),
            ]);
            if open(url.as_str()).is_err() {
                server.abort();
                return Err(error("Trae authorization browser could not be opened."));
            }
            let result = receiver
                .await
                .map_err(|_| error("Trae callback listener stopped."));
            server.abort();
            let (code, tag) = result??;
            let host = if tag == "usttp" { HOSTS[1] } else { HOSTS[0] };
            let client = client()?;
            let result=post(&client,host,EXCHANGE,"",json!({"ClientID":CLIENT_ID,"AuthCode":code,"CodeVerifier":verifier,"DeviceInfo":device_info(&binding),"IDEVersion":VERSION})).await?;
            let mut credential = TraeCredential {
                access: String::new(),
                refresh: String::new(),
                expires: 0,
                refresh_expires: 0,
                host: host.into(),
                client_id: CLIENT_ID.into(),
                device: binding,
                account_id: String::new(),
                label: String::new(),
                store_country: String::new(),
                models: Vec::new(),
            };
            update_tokens(&mut credential, &result)?;
            let user = post(
                &client,
                host,
                "/cloudide/api/v3/trae/GetUserInfo",
                &credential.access,
                json!({"IDEVersion":VERSION,"ReqSource":"IDE"}),
            )
            .await?;
            credential.account_id = text(&user, "UserID")?;
            credential.label = text(&user, "ScreenName")
                .or_else(|_| text(&user, "NonPlainTextEmail"))
                .unwrap_or_else(|_| credential.account_id.clone());
            credential.store_country = text(&user, "StoreCountry")?;
            credential.models = models(&client, &credential).await?;
            Ok(credential)
        },
        cancelled,
        Duration::from_secs(300),
    )
}
pub fn ready(account_id: &str) -> Result<TraeCredential> {
    let mut credential = crate::trae_store::load(account_id).map_err(AgentError::new)?;
    validate(&credential)?;
    if credential.expires <= now() + 60_000 {
        let expected_refresh = zeroize::Zeroizing::new(credential.refresh.clone());
        run(
            refresh(&client()?, &mut credential),
            None,
            Duration::from_secs(60),
        )?;
        crate::trae_store::replace_current(account_id, &expected_refresh, &credential)
            .map_err(AgentError::new)?;
    }
    Ok(credential)
}
fn encrypted_messages(
    conversation: &[ChatMessage],
    tools: &[ToolDefinition],
    pin: &[u8; 8],
    iv: &[u8; 12],
    timestamp: &str,
) -> Result<String> {
    if !tools.is_empty()
        || conversation.iter().any(|m| {
            matches!(m.role, Role::Tool) || !m.tool_calls.is_empty() || m.tool_call_id.is_some()
        })
    {
        return Err(error(
            "Trae text endpoint does not support tool definitions or tool history.",
        ));
    }
    if conversation.is_empty() {
        return Err(error("Trae requires at least one message."));
    }
    let messages = conversation
        .iter()
        .map(|m| json!({"role":m.role,"content":[{"type":"text","text":m.content}]}))
        .collect::<Vec<_>>();
    let mut key = [
        0x61, 0x95, 0xf2, 0x4c, 0xa4, 0xd4, 0x30, 0xf8, 0xa4, 0x83, 0x3d, 0xe7, 0xdb, 0x8d, 0xac,
        0x37, 0xd1, 0x48, 0xa0, 0x84, 0xe7, 0x46, 0x4a, 0x35, 0x1f, 0xfa, 0x68, 0x58, 0x5c, 0x16,
        0xb9, 0x55,
    ];
    for i in 0..8 {
        key[i] ^= pin[i];
    }
    let encrypted = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| error("Trae encryption unavailable."))?
        .encrypt(
            iv.into(),
            Payload {
                msg: json!(messages).to_string().as_bytes(),
                aad: timestamp.as_bytes(),
            },
        )
        .map_err(|_| error("Trae encryption failed."))?;
    let mut result = iv.to_vec();
    result.extend(encrypted);
    Ok(STANDARD.encode(result))
}
#[derive(Default)]
struct Completion {
    text: String,
    reasoning: String,
    usage: Option<Value>,
    done: bool,
}
impl Completion {
    fn event(&mut self, name: &str, data: &str) -> Result<()> {
        let value: Value =
            serde_json::from_str(data).map_err(|_| error("Trae stream returned invalid JSON."))?;
        if !value.is_object()
            || name == "error"
            || value.get("tool_calls").is_some()
            || value.get("function_call").is_some()
            || value["finish_reason"] == "tool_calls"
        {
            return Err(error(
                "Trae returned an error or unsupported tool response.",
            ));
        }
        if name == "metadata" || name == "progress_notice" {
            return Ok(());
        }
        if name == "token_usage" {
            for field in ["prompt_tokens", "completion_tokens", "total_tokens"] {
                if !value[field]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n >= 0.0)
                {
                    return Err(error("Trae returned invalid token usage."));
                }
            }
            self.usage = Some(value.clone());
        }
        for (field, target) in [
            ("response", &mut self.text),
            ("reasoning_content", &mut self.reasoning),
        ] {
            if let Some(delta) = value.get(field) {
                target.push_str(
                    delta
                        .as_str()
                        .ok_or_else(|| error("Trae returned an invalid text delta."))?,
                );
            }
        }
        if name == "done" {
            text(&value, "finish_reason")?;
            self.done = true;
        }
        Ok(())
    }
}
async fn parse_events(bytes: Vec<u8>) -> Result<Completion> {
    if ![
        b"\n\n".as_slice(),
        b"\r\r".as_slice(),
        b"\r\n\r\n".as_slice(),
        b"\n\r\n".as_slice(),
    ]
    .iter()
    .any(|ending| bytes.ends_with(ending))
    {
        return Err(error("Trae stream ended inside an event."));
    }
    let stream = futures_util::stream::iter(vec![Ok::<_, AgentError>(bytes)]);
    let mut events = stream.eventsource();
    let mut completion = Completion::default();
    while let Some(event) = events.next().await {
        let event = event.map_err(|_| error("Trae stream interrupted."))?;
        completion.event(&event.event, &event.data)?;
    }
    Ok(completion)
}
impl AgentProvider for TraeCodeProvider {
    fn id(&self) -> &str {
        "traecode"
    }
    fn step(&self, conversation: &[ChatMessage], tools: &[ToolDefinition]) -> Result<AgentStep> {
        let pin = random::<8>();
        let timestamp = (now() / 1000).to_string();
        let encrypted = encrypted_messages(conversation, tools, &pin, &random::<12>(), &timestamp)?;
        let credential = ready(&self.config.account_id)?;
        if !credential.models.contains(&self.config.model) {
            return Err(error("Trae account does not advertise the selected model."));
        }
        run(
            async {
                let response = api_request(
                    &client()?,
                    &credential,
                    "/api/ide/v1/llm_raw_chat",
                    reqwest::Method::POST,
                )?
                .header("X-Request-Pin", hex(&pin))
                .header("X-Requested-At", timestamp)
                .json(&json!({"model_name":self.config.model,"message":encrypted}))
                .send()
                .await
                .map_err(|_| AgentError::transport("Trae request failed."))?;
                let response = checked(response).await?;
                if !response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/event-stream"))
                {
                    return Err(error("Trae returned a non-streaming response."));
                }
                let mut bytes = Vec::new();
                let mut stream = response.bytes_stream();
                while let Some(part) = stream.next().await {
                    let part = part.map_err(|_| error("Trae stream interrupted."))?;
                    if bytes.len() + part.len() > MAX_RESPONSE {
                        return Err(error("Trae stream exceeds size limit."));
                    }
                    bytes.extend_from_slice(&part);
                }
                let completion = parse_events(bytes).await?;
                if !completion.done {
                    return Err(error("Trae stream ended before its completion marker."));
                }
                Ok(AgentStep {
                    assistant_text: Some(completion.text),
                    tool_calls: Vec::new(),
                })
            },
            None,
            Duration::from_secs(self.config.timeout_secs),
        )
    }
}
#[cfg(test)]
#[path = "../../../../../test/trae_browser.rs"]
mod tests;
