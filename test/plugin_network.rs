use std::net::SocketAddr;

use serde_json::json;
use synthv_toolbox_lib::unrestricted_network_request;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        let count = stream.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&buffer[..count]);
        let request = String::from_utf8_lossy(&bytes);
        let Some(headers_end) = request.find("\r\n\r\n") else {
            continue;
        };
        let content_length = request[..headers_end]
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .map(str::to_string)
            })
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_default();
        if bytes.len() >= headers_end + 4 + content_length {
            return request.into_owned();
        }
    }
}

async fn start_server() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let request = read_request(&mut first).await;
        assert!(request.starts_with("POST /redirect HTTP/1.1"));
        assert!(request.contains("x-plugin-token: value"));
        assert!(request.ends_with("request body"));
        first
            .write_all(b"HTTP/1.1 302 Found\r\nLocation: /complete\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();

        let (mut second, _) = listener.accept().await.unwrap();
        let request = read_request(&mut second).await;
        assert!(request.starts_with("GET /complete HTTP/1.1"));
        second
            .write_all(b"HTTP/1.1 201 Created\r\nX-Reply: accepted\r\nContent-Length: 16\r\nConnection: close\r\n\r\nnetwork response")
            .await
            .unwrap();
    });
    (address, task)
}

#[tokio::test]
async fn advanced_network_request_supports_local_http_methods_headers_bodies_and_redirects() {
    let (address, server) = start_server().await;
    let response = unrestricted_network_request(&json!({
        "url": format!("http://{address}/redirect"),
        "method": "POST",
        "headers": { "X-Plugin-Token": "value" },
        "bodyBase64": "cmVxdWVzdCBib2R5",
    }))
    .await
    .unwrap();
    server.await.unwrap();

    assert_eq!(response["status"], 201);
    assert_eq!(response["headers"]["x-reply"], "accepted");
    assert_eq!(response["body"], "network response");
    assert_eq!(response["bodyBase64"], "bmV0d29yayByZXNwb25zZQ==");
}

#[tokio::test]
async fn advanced_network_request_rejects_ambiguous_body_encodings() {
    let error = unrestricted_network_request(&json!({
        "url": "http://127.0.0.1/",
        "body": "text",
        "bodyBase64": "dGV4dA==",
    }))
    .await
    .unwrap_err();
    assert!(error.contains("不能同时提供"));
}
