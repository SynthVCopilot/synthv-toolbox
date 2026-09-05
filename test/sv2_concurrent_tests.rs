use super::*;

#[test]
fn each_launch_has_a_distinct_bounded_box_name() {
    let slot = Uuid::new_v4().to_string();
    let first = instance_box_name(&slot, &Uuid::new_v4().to_string()).unwrap();
    let second = instance_box_name(&slot, &Uuid::new_v4().to_string()).unwrap();
    assert_ne!(first, second);
    assert!(first.len() <= 32 && first.chars().all(|ch| ch.is_ascii_alphanumeric()));
    assert!(instance_box_name("../outside", &slot).is_err());
    assert!(instance_box_name(&slot, "../outside").is_err());
}

#[test]
fn invalid_pid_responses_are_errors() {
    for output in ["", "access denied", "2\n42", "1\n0", "1\n42\nextra"] {
        assert!(parse_pid_list(output).is_err(), "{output}");
    }
}

#[cfg(windows)]
#[test]
fn multiple_overlays_share_one_account_without_sharing_another() {
    let vault = std::env::temp_dir().join(format!("sv2-mapping-{}", Uuid::new_v4()));
    let slot_id = Uuid::new_v4().to_string();
    let slot = slot_data_root(&vault, &slot_id);
    let other = slot_data_root(&vault, &Uuid::new_v4().to_string());
    fs::create_dir_all(slot.join("databases")).unwrap();
    fs::create_dir_all(other.join("databases")).unwrap();
    fs::write(
        slot.join(".synthv-toolbox-slot.json"),
        format!(r#"{{"schemaVersion":1,"slotId":"{slot_id}"}}"#),
    )
    .unwrap();
    fs::write(slot.join("databases/voice"), b"account-one").unwrap();
    fs::write(other.join("databases/voice"), b"account-two").unwrap();
    let first = instance_box_root(&vault, &slot_id, &Uuid::new_v4().to_string());
    let second = instance_box_root(&vault, &slot_id, &Uuid::new_v4().to_string());
    create_overlay_slot_junction(&first, &slot).unwrap();
    create_overlay_slot_junction(&second, &slot).unwrap();
    fs::write(
        virtual_data_root(&first).join("databases/voice"),
        b"updated-one",
    )
    .unwrap();
    assert_eq!(
        fs::read(virtual_data_root(&second).join("databases/voice")).unwrap(),
        b"updated-one"
    );
    assert_eq!(
        fs::read(other.join("databases/voice")).unwrap(),
        b"account-two"
    );
    assert_eq!(validate_slot_root(&vault, &slot_id).unwrap(), slot);
    assert!(create_overlay_slot_junction(&first, &other).is_err());
    remove_slot_data(&vault, &slot_id).unwrap();
    assert!(slot.join("databases/voice").is_file());
    fs::remove_dir_all(vault).unwrap();
}

#[cfg(windows)]
#[test]
fn mapping_rejects_a_redirected_parent() {
    let root = std::env::temp_dir().join(format!("sv2-mapping-boundary-{}", Uuid::new_v4()));
    let instance = root.join("instance");
    let outside = root.join("outside");
    fs::create_dir_all(&instance).unwrap();
    fs::create_dir_all(&outside).unwrap();
    junction::create(&outside, instance.join("user")).unwrap();
    assert!(create_overlay_slot_junction(&instance, &outside).is_err());
    junction::delete(instance.join("user")).unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn pid_output_ignores_the_leading_count() {
    assert_eq!(
        parse_pid_list("3\r\n42\r\n7\r\n42\r\n").unwrap(),
        vec![7, 42]
    );
    assert_eq!(parse_pid_list("0\r\n").unwrap(), Vec::<u32>::new());
}
#[test]
fn shared_content_rules_are_scoped_to_a_directory() {
    let rule = sandbox_directory_rule(&std::env::temp_dir().join("sv2-settings")).unwrap();
    assert!(rule.ends_with(std::path::MAIN_SEPARATOR));
    assert!(!rule.contains(['\r', '\n', '\0']));
}

#[test]
fn utf16_command_output_is_decoded() {
    let text = "C:\\并发\\box\r\n";
    let bytes = text
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    assert_eq!(decode_output(&bytes), text);
}

#[test]
fn provider_version_rejects_known_vulnerable_builds() {
    assert!(!supported_provider_version((1, 17, 2, 0)));
    assert!(supported_provider_version((1, 17, 6, 0)));
    assert!(!supported_provider_version((5, 72, 2, 0)));
    assert!(supported_provider_version((5, 72, 6, 0)));
}

#[test]
fn provider_identity_matches_the_sandboxie_version_line() {
    assert_eq!(provider_name((1, 17, 6, 0)), "Sandboxie Plus");
    assert_eq!(provider_edition((1, 17, 6, 0)), "Plus");
    assert_eq!(provider_name((5, 73, 2, 0)), "Sandboxie Classic");
    assert_eq!(provider_edition((5, 73, 2, 0)), "Classic");
    assert_eq!(format_version((5, 73, 2, 0)), "5.73.2");
}
