use super::*;

fn stable(tag: &str) -> GitHubRelease {
    GitHubRelease {
        tag_name: tag.into(),
        name: None,
        html_url: format!("https://github.com/SynthVCopilot/synthv-toolbox/releases/tag/{tag}"),
        published_at: None,
        body: None,
    }
}

fn nightly(version: &str, committed: &str) -> NightlyManifest {
    NightlyManifest {
        schema_version: 1,
        channel: "nightly".into(),
        version: version.into(),
        commit: "abcdef0".into(),
        source_committed_at_utc: committed.into(),
        published_at_utc: committed.into(),
        release_url: "https://github.com/SynthVCopilot/synthv-toolbox/releases/tag/v0.2.0-nightly"
            .into(),
        changes: vec![],
    }
}

#[test]
fn stable_uses_semver_and_rejects_untrusted_links() {
    assert!(
        build_stable_update_check("0.1.0", stable("v0.2.0"))
            .unwrap()
            .update_available
    );
    assert!(
        !build_stable_update_check("1.0.0", stable("v0.2.0"))
            .unwrap()
            .update_available
    );
    let mut bad = stable("v0.2.0");
    bad.html_url = "https://example.test/release".into();
    assert!(build_stable_update_check("0.1.0", bad).is_err());
}

#[test]
fn nightly_exact_version_never_prompts() {
    let result = build_nightly_update_check(
        "0.2.0-dev.abcdef0",
        nightly("0.2.0-dev.abcdef0", "2099-01-01T00:00:00Z"),
    )
    .unwrap();
    assert!(!result.update_available);
}

#[test]
fn nightly_manifest_rejects_bad_shape() {
    let mut manifest = nightly("0.2.0-dev.abcdef0", "2026-01-01T00:00:00Z");
    manifest.channel = "stable".into();
    assert!(build_nightly_update_check("0.1.0", manifest).is_err());
}

#[test]
fn nightly_release_filter_uses_highest_non_draft_prerelease() {
    let releases = vec![
        GitHubReleaseSummary {
            tag_name: "v0.9.0-nightly".into(),
            prerelease: true,
            draft: false,
        },
        GitHubReleaseSummary {
            tag_name: "v1.0.0-nightly".into(),
            prerelease: true,
            draft: false,
        },
        GitHubReleaseSummary {
            tag_name: "v9.0.0-nightly".into(),
            prerelease: true,
            draft: true,
        },
        GitHubReleaseSummary {
            tag_name: "v8.0.0".into(),
            prerelease: false,
            draft: false,
        },
    ];
    let tag = releases
        .into_iter()
        .filter(|r| r.prerelease && !r.draft)
        .filter_map(|r| {
            let base = r.tag_name.strip_prefix('v')?.strip_suffix("-nightly")?;
            Some((parse_version(base, "test").ok()?, r.tag_name))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .unwrap()
        .1;
    assert_eq!(tag, "v1.0.0-nightly");
}
