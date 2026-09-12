use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use synthv_toolbox_lib::agent_runtime::{
    AgentRuntime, HostHello, RuntimeCommand, VersionRange, PROTOCOL_VERSION,
};

fn node_command(script: &str) -> RuntimeCommand {
    RuntimeCommand {
        program: PathBuf::from("node"),
        args: vec!["-e".to_string(), script.to_string()],
        current_dir: None,
    }
}

fn host_hello() -> HostHello {
    HostHello {
        host_id: "synthv-toolbox".to_string(),
        protocol: VersionRange::exact(PROTOCOL_VERSION),
        capabilities: Vec::new(),
    }
}

#[tokio::test]
async fn runtime_negotiates_and_handles_bidirectional_jsonl_messages() {
    let runtime = AgentRuntime::new();
    runtime
        .register_capability(
            "host.echo",
            Arc::new(|params| Box::pin(async move { Ok(params) })),
        )
        .await;
    let mut notifications = runtime.subscribe_notifications();
    let script = r#"
const readline = require('node:readline');
let sentCapability = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.kind === 'request' && message.method === 'host.hello') {
    process.stdout.write(JSON.stringify({ kind: 'response', id: message.id, protocolVersion: '1.0', ok: true,
      result: { runtimeId: 'node-runtime', protocol: { min: '1.0', max: '1.0' }, capabilities: [] } }) + '\n');
    if (!sentCapability) { sentCapability = true; process.stdout.write(JSON.stringify({ kind: 'request', id: 'capability-1', protocolVersion: '1.0', method: 'host.echo', params: { from: 'runtime' } }) + '\n'); }
  } else if (message.kind === 'request' && message.method === 'runtime.echo') {
    process.stdout.write(JSON.stringify({ kind: 'response', id: message.id, protocolVersion: '1.0', ok: true, result: message.params }) + '\n');
  } else if (message.kind === 'response' && message.id === 'capability-1') {
    process.stdout.write(JSON.stringify({ kind: 'notification', protocolVersion: '1.0', event: 'runtime.capability.complete', params: message }) + '\n');
  }
});
"#;
    let runtime_hello = runtime
        .start(node_command(script), host_hello())
        .await
        .unwrap();
    assert_eq!(runtime_hello.runtime_id, "node-runtime");
    assert_eq!(
        runtime
            .request("runtime.echo", json!({ "message": "hello" }))
            .await
            .unwrap(),
        json!({ "message": "hello" })
    );
    let notification = notifications.recv().await.unwrap();
    assert_eq!(notification.event, "runtime.capability.complete");
    assert_eq!(notification.params["result"], json!({ "from": "runtime" }));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn runtime_rejects_incompatible_hello() {
    let runtime = AgentRuntime::new();
    let script = r#"
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.kind === 'request' && message.method === 'host.hello') {
    process.stdout.write(JSON.stringify({ kind: 'response', id: message.id, protocolVersion: '1.0', ok: true,
      result: { runtimeId: 'future-runtime', protocol: { min: '2.0', max: '2.0' }, capabilities: [] } }) + '\n');
  }
});
"#;
    let error = runtime
        .start(node_command(script), host_hello())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("no compatible protocol version"));
    assert!(!runtime.is_running().await);
}
