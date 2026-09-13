# MCP client configuration

The bridge is a local **stdio** MCP server. Any client that can launch a stdio
server can use it; there is no network port and no client-specific code.

## Launch command

```
node /absolute/path/to/synthv-agent-bridge/dist/src/cli.js
```

Run `npm run build` first so `dist/src/cli.js` exists.

## Recommended settings

| Setting | Value | Reason |
|---|---|---|
| Server name | `synthv-agent-bridge` | Matches the name reported over MCP. |
| Startup timeout | 10 s (120 s on first launch) | The first launch may compile or warm caches. |
| Tool timeout | 30 s | Long reads and guarded writes wait on the SynthV host. |

## JSON clients

Most clients use an `mcpServers` object:

```json
{
  "mcpServers": {
    "synthv-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/synthv-agent-bridge/dist/src/cli.js"]
    }
  }
}
```

## TOML clients

```toml
[mcp_servers.synthv-agent-bridge]
command = "node"
args = ["/absolute/path/to/synthv-agent-bridge/dist/src/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 30
```

Key names differ between clients; consult the client's own documentation for the
exact table or field names.

## Split temporary directories

Node and SynthV must resolve the same IPC directory. When they do not — for
example Node under WSL and SynthV on Windows — set
`SYNTHV_AGENT_BRIDGE_DIR` for the server process:

```json
{
  "mcpServers": {
    "synthv-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/synthv-agent-bridge/dist/src/cli.js"],
      "env": { "SYNTHV_AGENT_BRIDGE_DIR": "/mnt/c/Users/you/AppData/Local/Temp" }
    }
  }
}
```

The SynthV GUI inherits its own Windows environment variable, so restart SynthV
after changing it. Both processes must point at the same directory using the
path spelling each one understands.
