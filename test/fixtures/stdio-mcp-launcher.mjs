// Starts the stdio MCP fixture on the inherited pipes and exits at once, as npx can, leaving the real server running with
// the pipes open. POSIX only: on Windows libuv puts children in a kill-on-close job, so test/mcp-stdio-probe.mjs uses a
// cmd.exe `start /b` shim there instead. The server stays in this launcher's process group, as it does behind npx.
import { spawn } from "node:child_process";

spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" }).unref();
process.exit(0);
