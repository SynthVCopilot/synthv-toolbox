use super::*;

#[cfg(windows)]
#[test]
#[ignore = "reads and decrypts the explicitly supplied local SV2 session without contacting services"]
fn reports_session_format_validation_stages_without_exposing_credentials() {
    assert_eq!(
        std::env::var("SV2_SESSION_FORMAT_DIAGNOSTIC").as_deref(),
        Ok("true"),
        "set SV2_SESSION_FORMAT_DIAGNOSTIC=true to inspect an explicitly supplied local session"
    );
    let root = PathBuf::from(
        std::env::var("SV2_SESSION_FORMAT_DIAGNOSTIC_ROOT")
            .expect("explicit session root required"),
    );
    assert!(root.is_absolute());

    let (encrypted, _) = read_stable_session(&root)
        .expect("stable session read failed")
        .expect("session missing");
    let encrypted_len = encrypted.len();
    let key = read_machine_key().expect("machine key unavailable");
    let plaintext = match decrypt_session(encrypted, &key) {
        Ok(plaintext) => plaintext,
        Err(()) => {
            eprintln!(
                "SV2 session format diagnostic: encrypted_bytes={encrypted_len}, block_aligned={}, decrypt=failed",
                encrypted_len.is_multiple_of(8),
            );
            return;
        }
    };

    let plaintext_len = plaintext.len();
    let text = match std::str::from_utf8(&plaintext) {
        Ok(text) => text,
        Err(_) => {
            eprintln!(
                "SV2 session format diagnostic: encrypted_bytes={encrypted_len}, block_aligned={}, decrypt=ok, plaintext_bytes={plaintext_len}, utf8=false",
                encrypted_len.is_multiple_of(8),
            );
            return;
        }
    };
    let carriage_return = text.as_bytes().contains(&b'\r');
    let lines = text.split('\n').collect::<Vec<_>>();
    let line_count = lines.len();
    let line_lengths = lines.iter().map(|value| value.len()).collect::<Vec<_>>();
    let line_types = lines
        .iter()
        .map(|value| {
            if value.is_empty() {
                "empty"
            } else if parse_jwt(value, false).is_ok() {
                "jwt"
            } else if parse_session_time(value).is_ok() {
                "rfc3339"
            } else if value.is_ascii() {
                "ascii"
            } else {
                "unicode"
            }
        })
        .collect::<Vec<_>>();
    let access_claims = lines.first().and_then(|value| parse_jwt(value, true).ok());
    let refresh_claims = lines.get(1).and_then(|value| parse_jwt(value, false).ok());
    let access_expiry = lines
        .get(2)
        .and_then(|value| parse_session_time(value).ok());
    let session_written = lines
        .get(3)
        .and_then(|value| parse_session_time(value).ok());
    let expiry_matches_claim = access_expiry
        .zip(access_claims.as_ref().and_then(|claims| claims.exp))
        .is_some_and(|(expiry, claim)| timestamp_near_claim(expiry, claim));
    let expiry_is_past = access_expiry.is_some_and(|expiry| expiry <= Utc::now());
    let required_lines_nonempty =
        lines.len() >= 5 && lines[..4].iter().all(|value| !value.is_empty());
    let device_line_valid = lines
        .get(4)
        .is_some_and(|value| value.len() <= 512 && !value.chars().any(char::is_control));
    let parser_ok = parse_session_plaintext(plaintext).is_ok();

    eprintln!(
        "SV2 session format diagnostic: encrypted_bytes={encrypted_len}, block_aligned={}, decrypt=ok, plaintext_bytes={plaintext_len}, utf8=true, lines={line_count}, line_lengths={line_lengths:?}, line_types={line_types:?}, carriage_return={}, required_lines_nonempty={required_lines_nonempty}, device_line_valid={device_line_valid}, access_jwt={}, refresh_jwt={}, access_expiry_rfc3339={}, session_written_rfc3339={}, access_expiry_matches_claim={expiry_matches_claim}, access_expiry_past={expiry_is_past}, parser_ok={parser_ok}",
        encrypted_len.is_multiple_of(8),
        carriage_return,
        access_claims.is_some(),
        refresh_claims.is_some(),
        access_expiry.is_some(),
        session_written.is_some(),
    );
}
