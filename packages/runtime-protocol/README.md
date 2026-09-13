# Runtime protocol

`@synthv-toolbox/runtime-protocol` is the dependency-free contract shared by the Native Host, Agent Runtime and plugins. It defines the JSON Lines RPC envelope, capability handshake, API-version negotiation and plugin manifest validation.

Consumers exchange one `RpcMessage` per UTF-8 line. They must send a `host.hello` or `runtime.hello` request before invoking capabilities, select the version returned by `negotiateProtocolVersion`, and reject a plugin when `isHostApiCompatible` returns `false`.

The package contains no UI, Tauri commands or process management code, so it can be built and released independently.
