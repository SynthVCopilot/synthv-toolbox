# Agent Runtime

This package runs separately from the Native Host and workbench. Its JSON Lines worker performs protocol negotiation, session creation, prompts and cleanup. The Pi coding-agent SDK is isolated behind `PiSessionFactory` so its SDK lifecycle remains replaceable without changing the host protocol.

`ModelAuthGateway` routes credentials with `@model-auth/core` and forwards only to `ProviderAdapterHost.request` or `.stream` when the supplied adapter implements them. If a provider cannot be represented by the current Pi integration, callers receive `unsupported` instead of a simulated result.

Plugin backends are loaded only after their manifest passes the shared validator and host API compatibility check. A backend receives only declared permissions and an explicit host-capability invocation function.

`synthv-agent-runtime` is the executable JSONL worker. It reads one request per stdin line, writes only JSONL responses to stdout, and writes diagnostics to stderr. `runtime.plugins.discover` accepts a plugin root path, loads compatible `manifest.json` backends, and returns the activated manifests.
