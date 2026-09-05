use std::{io::Read, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("SV2_HTTP_DIAGNOSTIC").as_deref() != Ok("true") {
        return Err("set SV2_HTTP_DIAGNOSTIC=true to send placeholder requests".into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .redirects(0)
        .build();
    let response = agent
            .post("https://account.dreamtonics.com/realms/Dreamtonics/protocol/openid-connect/token")
            .set("Accept", "application/json")
            .set("Content-Type", "application/x-www-form-urlencoded")
            .set("User-Agent", "SynthV-Toolbox/account-indicator")
            .send_string("grant_type=refresh_token&refresh_token=toolbox-invalid-diagnostic&client_id=svstudio2-agent");
    let response = match response {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(_)) => {
            return Err("placeholder token request failed in transport".into());
        }
    };
    let status = response.status();
    let json = response.content_type() == "application/json";
    let challenge = response.header("cf-mitigated") == Some("challenge");
    let mut body = String::new();
    response
        .into_reader()
        .take(65536)
        .read_to_string(&mut body)?;
    let invalid_grant = body.contains("invalid_grant");
    println!("status={status}, json={json}, challenge={challenge}, invalid_grant={invalid_grant}");
    if status != 400 || !json || !invalid_grant {
        return Err("placeholder request did not reach the expected OAuth rejection".into());
    }
    Ok(())
}
