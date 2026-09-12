# SV2 session kit

Build the offline utility with `cargo build --manifest-path src/PiDesktop.Tauri/src-tauri/Cargo.toml --bin sv2-session-kit`.

`inspect` and `compare` accept explicit encrypted session paths and redact credentials. `export` writes raw plaintext only to an explicitly named new file. `encode` validates plaintext and creates a new encrypted file using the local machine key. No command calls a network service or refreshes a session.

`apply` prints a preview by default. Supply both displayed SHA-256 values and add `--commit` only after review. It refuses a running `synthv-studio` or `synthv-toolbox`, creates and verifies a timestamped backup, and uses a replacement file. Product fields are unverified local metadata, not authorization proof.

```text
sv2-session-kit inspect <encrypted-session>
sv2-session-kit compare <left> <right>
sv2-session-kit export <encrypted-session> <new-plaintext-output>
sv2-session-kit encode <plaintext-session> <new-encrypted-output>
sv2-session-kit apply <source> <destination> --source-sha256 <hash> --destination-sha256 <hash> [--commit]
```
