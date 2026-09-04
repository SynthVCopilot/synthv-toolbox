use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use synthv_toolbox_lib::agent::*;

fn server(
    responses: Vec<(u16, &'static str)>,
) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake server");
    let address = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);
    let handle = thread::spawn(move || {
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().expect("accept fake request");
            let request = read_request(&mut stream);
            captured.lock().unwrap().push(request);
            let reason = if status == 200 { "OK" } else { "Error" };
            let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nSet-Cookie: session=test; Path=/; HttpOnly\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    (address, requests, handle)
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end;
    loop {
        let count = stream.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length: ")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            while bytes.len() < header_end + length {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            break;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: "test tool".into(),
        input_schema_json: r#"{"type":"object","properties":{"value":{"type":"string"}}}"#.into(),
    }
}

#[test]
fn openai_chat_maps_json_messages_tools_and_redacts_key() {
    let body = r#"{"choices":[{"message":{"role":"assistant","content":"hello","tool_calls":[{"id":"call-1","type":"function","function":{"name":"inspect","arguments":"{\"value\":\"x\"}"}}]}}]}"#;
    let (base, requests, handle) = server(vec![(200, body)]);
    let config = OpenAiChatConfig::new(base, "chat-secret", "model-a");
    assert!(!format!("{:?}", config).contains("chat-secret"));
    let provider = OpenAiChatProvider::new(config);
    let conversation = vec![
        ChatMessage::user("question"),
        ChatMessage {
            role: Role::Assistant,
            content: "".into(),
            tool_calls: vec![ToolCall {
                id: "previous".into(),
                tool_name: "inspect".into(),
                arguments_json: r#"{"value":"y"}"#.into(),
            }],
            tool_call_id: None,
        },
        ChatMessage {
            role: Role::Tool,
            content: "result".into(),
            tool_calls: Vec::new(),
            tool_call_id: Some("previous".into()),
        },
    ];
    let step = provider.step(&conversation, &[tool("inspect")]).unwrap();
    assert_eq!(step.assistant_text.as_deref(), Some("hello"));
    assert_eq!(step.tool_calls[0].tool_name, "inspect");
    let request = requests.lock().unwrap()[0].clone();
    assert!(request.contains("\"role\":\"tool\""));
    assert!(request.contains("\"parallel_tool_calls\":true"));
    assert!(request.contains("chat-secret"));
    handle.join().unwrap();
}

#[test]
fn openai_chat_parses_bounded_sse_and_classifies_http() {
    let body = r#"data: {"choices":[{"delta":{"content":"hi"}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"inspect","arguments":"{\"a\":1}"}}]}}]}

data: [DONE]

"#;
    let (base, _, handle) = server(vec![(200, body)]);
    let provider = OpenAiChatProvider::new(OpenAiChatConfig::new(base, "secret", "model"));
    let step = provider.step(&[ChatMessage::user("x")], &[]).unwrap();
    assert_eq!(step.assistant_text.as_deref(), Some("hi"));
    assert_eq!(step.tool_calls[0].arguments_json, r#"{"a":1}"#);
    handle.join().unwrap();

    let (base, _, handle) = server(vec![(429, "{\"error\":\"slow\"}")]);
    let provider = OpenAiChatProvider::new(OpenAiChatConfig::new(base, "secret", "model"));
    assert_eq!(
        provider
            .step(&[ChatMessage::user("x")], &[])
            .unwrap_err()
            .kind(),
        AgentErrorKind::Http(429)
    );
    handle.join().unwrap();
}

fn workbuddy_config(base: &str) -> WorkBuddyOAuthConfig {
    WorkBuddyOAuthConfig {
        api_base: base.into(),
        chat_base: format!("{base}/chat"),
        origin: "https://workbuddy.example".into(),
        models: vec!["work-model".into()],
        platform: "workbuddy".into(),
        max_poll_attempts: 3,
        poll_interval_ms: 1,
        timeout_secs: 5,
    }
}

#[test]
fn workbuddy_oauth_builds_state_url_polls_refreshes_and_reads_account() {
    let (base, requests, handle) = server(vec![
        (
            200,
            r#"{"state":"state-1","authUrl":"https://workbuddy.example/authorize/state-1"}"#,
        ),
        (200, r#"{"code":11217,"message":"pending"}"#),
        (
            200,
            r#"{"code":0,"data":{"access":"access-secret","refresh":"refresh-secret","expiresIn":"3600","domain":"tenant.example","userId":"user-1","enterpriseId":"ent-1"}}"#,
        ),
        (
            200,
            r#"{"code":0,"data":{"access":"new-access","refresh":"new-refresh","expiresIn":"7200"}}"#,
        ),
        (
            200,
            r#"{"code":0,"data":{"uid":"acct-1","nickname":"Work User","email":"user@example.test","enterpriseId":"ent-1"}}"#,
        ),
    ]);
    let config = workbuddy_config(&base);
    assert!(!format!("{:?}", config).contains("secret"));
    let oauth = WorkBuddyOAuth::new(config);
    assert_eq!(oauth.models(), &["work-model"]);
    let auth = oauth.request_auth_state().unwrap();
    assert_eq!(auth.state, "state-1");
    assert!(auth.auth_url.contains("authorize"));
    let credential = oauth.poll_credential(&auth.state).unwrap();
    assert!(!format!("{:?}", credential).contains("access-secret"));
    let refreshed = oauth.refresh_credential(&credential).unwrap();
    let chat_headers = oauth.chat_headers(&refreshed).unwrap();
    assert!(chat_headers
        .iter()
        .any(|(name, value)| name == "authorization" && value == "Bearer new-access"));
    assert!(chat_headers
        .iter()
        .any(|(name, value)| name == "x-domain" && value == "tenant.example"));
    assert!(chat_headers
        .iter()
        .any(|(name, value)| name == "x-enterprise-id" && value == "ent-1"));
    assert_eq!(
        oauth.chat_endpoint().unwrap().path(),
        "/chat/chat/completions"
    );
    let account = oauth.account_info(&auth.state, &credential).unwrap();
    assert_eq!(account.user_id, "acct-1");
    assert_eq!(refreshed.user_id.as_deref(), Some("user-1"));
    let captured = requests.lock().unwrap().join("\n");
    assert!(captured.contains("platform=workbuddy"));
    assert!(captured.contains("state=state-1"));
    assert!(captured.contains("authorization: Bearer access-secret"));
    assert!(captured.contains("x-domain: tenant.example"));
    assert!(captured.contains("x-enterprise-id: ent-1"));
    assert!(captured.contains("x-requested-with: XMLHttpRequest"));
    assert!(captured.contains("x-product: SaaS"));
    assert!(captured.contains("refresh-secret"));
    assert!(captured.contains("x-refresh-token: refresh-secret"));
    assert!(captured.contains("x-auth-refresh-source: workbuddy"));
    assert!(captured
        .to_ascii_lowercase()
        .contains("cookie: session=test"));
    handle.join().unwrap();
}

#[cfg(unix)]
#[test]
fn traecode_uses_read_only_ephemeral_schema_and_parses_output() {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(format!("synthv-traecode-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let script = directory.join("traecli");
    std::fs::write(&script, "#!/bin/sh\nlog=\"$(dirname \"$0\")/argv.log\"\nif [ \"$1\" = \"login\" ]; then : > \"$log\"; if [ \"$2\" = \"status\" ]; then echo '{\"loggedIn\":true}'; else echo '{\"loggedIn\":true}'; fi; exit 0; fi\n: > \"$log\"\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\" >> \"$log\"; done\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--output-last-message\" ]; then shift; printf '%s' '{\"assistantText\":\"done\",\"toolCalls\":[{\"id\":\"c1\",\"tool_name\":\"inspect\",\"arguments_json\":\"{\\\"x\\\":1}\"}]}' > \"$1\"; echo '{\"diagnostic\":true}'; exit 0; fi\n  shift\ndone\necho '{\"diagnostic\":true}'\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut config = TraeCodeConfig::new("trae-model");
    config.executable = Some(PathBuf::from(&script));
    let provider = TraeCodeProvider::new(config);
    let status = provider.login_status().unwrap();
    assert!(status.available && status.logged_in);
    let args = provider
        .build_exec_args(
            &[ChatMessage::user("read")],
            &[tool("inspect")],
            &directory.join("schema.json"),
            &directory.join("last-message.json"),
        )
        .unwrap();
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--ephemeral", "--sandbox"]));
    assert!(args.contains(&"read-only".to_string()));
    assert!(args.contains(&"--skip-git-repo-check".to_string()));
    assert!(!args.contains(&"--prompt".to_string()));
    let step = provider.step(&[ChatMessage::user("read")], &[]).unwrap();
    assert_eq!(step.assistant_text.as_deref(), Some("done"));
    assert_eq!(step.tool_calls[0].tool_name, "inspect");
    let argv = std::fs::read_to_string(directory.join("argv.log")).unwrap();
    let argv = argv.lines().collect::<Vec<_>>();
    assert_eq!(argv[0], "exec");
    assert_eq!(argv[1], "--json");
    assert_eq!(argv[2], "--output-schema");
    assert!(argv[3].ends_with("/output-schema.json"));
    assert_eq!(argv[4], "--output-last-message");
    assert!(argv[5].ends_with("/last-message.json"));
    assert_eq!(argv[6], "--ephemeral");
    assert_eq!(argv[7], "--sandbox");
    assert_eq!(argv[8], "read-only");
    assert_eq!(argv[9], "--skip-git-repo-check");
    assert!(argv[10].contains("\"read\""));
    std::fs::remove_dir_all(directory).unwrap();
}
