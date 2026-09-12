# SV2 session kit

Build the offline utility with `cargo build --manifest-path src/PiDesktop.Tauri/src-tauri/Cargo.toml --bin sv2-session-kit`.

Native machine-key reading and guarded apply currently support Windows. Files encrypted for another machine cannot be decoded with this machine's key.

`inspect` and `compare` accept explicit encrypted session paths and redact credentials. `export` writes raw plaintext only to an explicitly named new file. `encode` validates plaintext and creates a new encrypted file using the local machine key. No command calls a network service or refreshes a session.

Keep edited plaintext in UTF-8 without a BOM and preserve LF line endings. `encode` rejects CRLF input and invalid session headers.

`apply` prints a preview by default. Supply both displayed SHA-256 values and add `--commit` only after review. It refuses a running `synthv-studio` or `synthv-toolbox`, creates and verifies a timestamped backup, and uses a replacement file. Product fields are unverified local metadata, not authorization proof.

The automatic backup covers the destination session file only. Preserve a full SV2 data-directory backup separately before changing an active installation. Raw exports contain login credentials; export them only to a private local directory. Restoring a local file does not restore server-side authorization state.

```text
sv2-session-kit inspect <encrypted-session>
sv2-session-kit compare <left> <right>
sv2-session-kit export <encrypted-session> <new-plaintext-output>
sv2-session-kit encode <plaintext-session> <new-encrypted-output>
sv2-session-kit apply <source> <destination> --source-sha256 <hash> --destination-sha256 <hash> [--commit]
```
