#!/usr/bin/env node
import { runLegacyStdioServer } from "./server.js";

runLegacyStdioServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
