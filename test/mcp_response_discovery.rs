use super::*;

#[test]
fn external_tool_names_are_sanitized_and_bounded() {
    let name = namespaced_tool_name("my.server", &"tool name/with spaces".repeat(8));
    assert!(name.starts_with("mcp_my_server_"));
    assert!(name.len() <= 64);
    assert!(name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-')));
}

#[test]
fn synthv_tools_keep_their_stable_public_names() {
    let listed = json!({
        "tools": [{
            "name": "sv_status",
            "description": "Read status",
            "inputSchema": { "type": "object" }
        }]
    });
    let tools = parse_tools("synthv", "SynthV Bridge", &listed);
    assert_eq!(tools[0].definition.name, "sv_status");
    assert_eq!(tools[0].remote_name, "sv_status");
}

#[test]
fn parses_json_text_blocks_without_interpreting_plain_text_as_a_path() {
    let response = json!({
        "content": [
            { "type": "text", "text": "completed project: C:/lyrics.svp" },
            { "type": "text", "text": "{\"project\":{\"filePath\":\"C:/work/song.svp\"}}" }
        ]
    });
    assert_eq!(
        mcp_json_values(&response),
        vec![json!({ "project": { "filePath": "C:/work/song.svp" } })]
    );
}
