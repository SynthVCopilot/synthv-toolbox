use std::path::PathBuf;

use serde_json::json;
use synthv_toolbox_lib::agent_runtime::{AgentRuntime, RuntimeCommand, RuntimeError};

fn node_command(script: &str) -> RuntimeCommand {
    RuntimeCommand {
        program: PathBuf::from("node"),
        args: vec!["-e".to_string(), script.to_string()],
        current_dir: None,
    }
}

#[tokio::test]
async fn runtime_correlates_jsonl_responses_and_stops_child() {
    let runtime = AgentRuntime::new();
    let script = r#"
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'request') {
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, result: request.params }) + '\n');
  }
});
"#;
    runtime.start(node_command(script)).await.unwrap();

    let reply = runtime
        .request("runtime.echo", json!({ "message": "hello" }))
        .await
        .unwrap();

    assert_eq!(reply, json!({ "message": "hello" }));
    assert!(runtime.is_running().await);
    runtime.shutdown().await.unwrap();
    assert!(!runtime.is_running().await);
    assert!(matches!(
        runtime.request("runtime.echo", json!({})).await,
        Err(RuntimeError::NotRunning)
    ));
}
