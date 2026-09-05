//! Flat 本机 Streamable HTTP MCP 客户端。
//!
//! 只接受明确构造的 loopback 端点，不读取或修改 Flat 配置。

use std::io::Read;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::task;
use url::Url;

const PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_RESPONSE_BYTES: usize = 8 * 1_048_576;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug)]
pub struct McpHttpClient {
    endpoint: String,
    next_id: AtomicI64,
}

impl McpHttpClient {
    pub fn from_port(port: u16) -> Result<Self, String> {
        Self::from_endpoint(format!("http://127.0.0.1:{port}/mcp"))
    }

    pub fn from_endpoint(endpoint: String) -> Result<Self, String> {
        validate_endpoint(&endpoint)?;
        Ok(Self {
            endpoint,
            next_id: AtomicI64::new(0),
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub async fn initialize(
        &self,
        client_name: &str,
        client_version: &str,
    ) -> Result<Value, String> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "clientInfo": { "name": client_name, "version": client_version }
        });
        let result = self.request("initialize", params).await?;
        if result.get("protocolVersion").and_then(Value::as_str) != Some(PROTOCOL_VERSION) {
            return Err(format!(
                "Flat MCP 协商返回的 protocolVersion 必须为 {PROTOCOL_VERSION}。"
            ));
        }
        self.notify_initialized().await?;
        Ok(result)
    }

    pub async fn notify_initialized(&self) -> Result<(), String> {
        let endpoint = self.endpoint.clone();
        task::spawn_blocking(move || {
            post_json(&endpoint, None, "notifications/initialized", json!({}))
        })
        .await
        .map_err(|error| format!("HTTP MCP notification task failed: {error}"))??;
        Ok(())
    }

    pub async fn list_tools(&self) -> Result<Value, String> {
        self.request("tools/list", json!({})).await
    }

    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, String> {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let endpoint = self.endpoint.clone();
        let method = method.to_string();
        task::spawn_blocking(move || post_json(&endpoint, Some(id), method, params))
            .await
            .map_err(|error| format!("HTTP MCP request task failed: {error}"))?
    }
}

fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let url = Url::parse(endpoint).map_err(|error| format!("非法 Flat MCP endpoint：{error}"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/mcp"
        || url.port().is_none()
        || url.port() == Some(0)
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Flat MCP endpoint 必须严格为 http://127.0.0.1:<port>/mcp。".into());
    }
    Ok(())
}

fn post_json(
    endpoint: &str,
    expected_id: Option<i64>,
    method: impl AsRef<str>,
    params: Value,
) -> Result<Value, String> {
    let mut body = json!({ "jsonrpc": "2.0", "method": method.as_ref(), "params": params });
    if let Some(id) = expected_id {
        body["id"] = json!(id);
    }
    let body = serde_json::to_vec(&body).map_err(|error| format!("编码 JSON-RPC 失败：{error}"))?;
    let agent = ureq::AgentBuilder::new()
        .timeout(REQUEST_TIMEOUT)
        .timeout_connect(REQUEST_TIMEOUT)
        .timeout_read(REQUEST_TIMEOUT)
        .timeout_write(REQUEST_TIMEOUT)
        .redirects(0)
        .try_proxy_from_env(false)
        .build();
    let response = agent
        .post(endpoint)
        .set("Accept", "application/json, text/event-stream")
        .set("Content-Type", "application/json")
        .set("MCP-Protocol-Version", PROTOCOL_VERSION)
        .set("Content-Length", &body.len().to_string())
        .send_bytes(&body)
        .map_err(|error| match error {
            ureq::Error::Status(status, response) => match read_bounded(response) {
                Ok(bytes) if bytes.is_empty() => format!("Flat MCP 返回 HTTP {status}。"),
                Ok(bytes) => format!(
                    "Flat MCP 返回 HTTP {status}：{}",
                    concise_error_body(&bytes)
                ),
                Err(error) => error,
            },
            error => format!("Flat MCP HTTP 请求失败：{error}"),
        })?;
    let status = response.status();
    let content_type = response
        .header("Content-Type")
        .unwrap_or("application/json")
        .to_ascii_lowercase();
    let bytes = read_bounded(response)?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "Flat MCP 返回 HTTP {status}：{}",
            concise_error_body(&bytes)
        ));
    }
    if expected_id.is_none() && bytes.is_empty() {
        return Ok(Value::Null);
    }
    let value = if content_type.starts_with("text/event-stream") {
        parse_sse(&bytes)?
    } else if content_type.starts_with("application/json") {
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("Flat MCP 返回无效 JSON：{error}"))?
    } else {
        return Err(format!(
            "Flat MCP 返回不支持的 Content-Type：{content_type}"
        ));
    };
    validate_response(&value, expected_id)
}

fn read_bounded(response: ureq::Response) -> Result<Vec<u8>, String> {
    if let Some(length) = response
        .header("Content-Length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        if length > MAX_RESPONSE_BYTES {
            return Err(format!("Flat MCP 响应超过 {MAX_RESPONSE_BYTES} 字节限制。"));
        }
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 Flat MCP 响应失败：{error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!("Flat MCP 响应超过 {MAX_RESPONSE_BYTES} 字节限制。"));
    }
    Ok(bytes)
}

fn parse_sse(bytes: &[u8]) -> Result<Value, String> {
    let mut data = None;
    let mut terminated = false;
    for line in String::from_utf8_lossy(bytes).lines() {
        if line.is_empty() {
            if data.is_some() {
                terminated = true;
            }
            continue;
        }
        if terminated {
            return Err("Flat MCP 仅支持包含单个 data 事件的 SSE 响应。".into());
        }
        if let Some(value) = line.strip_prefix("data:") {
            if data.is_some() {
                return Err("Flat MCP 仅支持包含单个 data 事件的 SSE 响应。".into());
            }
            data = Some(value.trim_start().to_string());
        }
    }
    let Some(data) = data else {
        return Err("Flat MCP SSE 响应没有 data 事件。".into());
    };
    serde_json::from_str(data.trim())
        .map_err(|error| format!("Flat MCP SSE data 不是有效 JSON：{error}"))
}

fn concise_error_body(bytes: &[u8]) -> String {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).chars().take(240).collect())
}

fn validate_response(value: &Value, expected_id: Option<i64>) -> Result<Value, String> {
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("Flat MCP 响应缺少 JSON-RPC 2.0 标记。".into());
    }
    if let Some(id) = expected_id {
        if value.get("id").and_then(Value::as_i64) != Some(id) {
            return Err("Flat MCP 响应 id 与请求不匹配。".into());
        }
    }
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知 MCP 错误");
        return Err(format!("Flat MCP JSON-RPC 错误：{message}"));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "Flat MCP 响应缺少 result。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn server(responses: Vec<String>) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                let header_end = loop {
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0, "客户端提前关闭请求");
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                assert!(headers.starts_with("POST /mcp HTTP/1.1\r\n"));
                assert!(headers.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
                assert!(headers.contains("Content-Type: application/json\r\n"));
                assert!(headers.contains("Accept: application/json, text/event-stream\r\n"));
                assert!(headers.contains("MCP-Protocol-Version: 2025-06-18\r\n"));
                assert!(!headers.to_ascii_lowercase().contains("transfer-encoding:"));
                let content_length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("Content-Length: "))
                    .and_then(|value| value.parse::<usize>().ok())
                    .expect("缺少 Content-Length");
                while request.len() < header_end + content_length {
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0, "请求体不完整");
                    request.extend_from_slice(&chunk[..count]);
                }
                assert_eq!(request.len(), header_end + content_length);
                write!(stream, "{response}").unwrap();
            }
        });
        (port, handle)
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    #[tokio::test]
    async fn handshake_and_call_use_expected_protocol() {
        let (port, handle) = server(vec![
            json_response(r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}"#),
            "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            json_response(r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#),
            json_response(r#"{"jsonrpc":"2.0","id":3,"result":{"content":[]}}"#),
        ]);
        let client = McpHttpClient::from_port(port).unwrap();
        assert_eq!(
            client.initialize("test", "0").await.unwrap()["protocolVersion"],
            "2025-06-18"
        );
        assert_eq!(client.list_tools().await.unwrap()["tools"], json!([]));
        assert_eq!(
            client.call_tool("ping", json!({})).await.unwrap()["content"],
            json!([])
        );
        handle.join().unwrap();
    }

    #[test]
    fn rejects_non_loopback_endpoints() {
        for endpoint in [
            "https://127.0.0.1:1/mcp",
            "http://localhost:1/mcp",
            "http://127.0.0.1:1/other",
            "http://127.0.0.1:1/mcp?x=1",
        ] {
            assert!(McpHttpClient::from_endpoint(endpoint.into()).is_err());
        }
    }

    #[test]
    fn validates_rpc_errors_and_response_size() {
        assert!(validate_response(
            &json!({"jsonrpc":"2.0","id":1,"error":{"message":"no"}}),
            Some(1)
        )
        .is_err());
        assert!(validate_response(&json!({"jsonrpc":"2.0","id":2,"result":{}}), Some(1)).is_err());
        assert!(
            parse_sse(b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n")
                .is_ok()
        );
        assert!(parse_sse(b"data: {}\ndata: {}\n").is_err());
    }

    #[tokio::test]
    async fn initialize_rejects_protocol_version_mismatch() {
        let (port, handle) = server(vec![json_response(
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}"#,
        )]);
        let client = McpHttpClient::from_port(port).unwrap();
        assert!(client.initialize("test", "0").await.is_err());
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn rejects_rpc_error_and_oversized_response_from_server() {
        let error_body = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"bad"}}"#;
        let huge = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            MAX_RESPONSE_BYTES + 1,
            "x"
        );
        let (port, handle) = server(vec![
            format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                error_body.len(),
                error_body
            ),
            huge,
        ]);
        let client = McpHttpClient::from_port(port).unwrap();
        assert!(client.list_tools().await.is_err());
        assert!(client.list_tools().await.is_err());
        handle.join().unwrap();
    }
}
