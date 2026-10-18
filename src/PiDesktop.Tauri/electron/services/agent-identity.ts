import { createHash } from "node:crypto";
import { BRAND } from "../brand.js";

export interface AgentIdentityContext {
  synthv: boolean;
  /** Enabled external MCP servers as passed to the session; only names reach the model, the rest feeds the digest. */
  mcpServers?: ReadonlyArray<{ name: string }>;
}

/**
 * Base prompt for the built-in agent. Without it Pi presents itself as a coding assistant. The runtime reuses a
 * session while its prompt is unchanged, so everything that changes the session's tool set (active integrations,
 * the external MCP server configuration) is part of the text. Tool names stay out: each extension introduces its
 * own tools, and Cover repair or tuning sessions have a different set.
 */
export function agentSystemPrompt(context: AgentIdentityContext): string {
  const servers = context.mcpServers ?? [];
  return [
    `You are the assistant built into ${BRAND.productName} (${BRAND.productNameZh}), a desktop toolbox for vocal and audio creation: audio preparation and separation, analysis, audio-to-MIDI, lyrics, and optional host integrations.`,
    "Act only through the tools available in this session. You cannot read files, run commands, or reach the network any other way.",
    "When a request needs a capability that no available tool provides, say so plainly and use request_input to agree on a next step instead of guessing.",
    "Reply in the language the user writes in.",
    `Active integrations: ${context.synthv ? "Synthesizer V" : "none"}.`,
    ...(servers.length ? [`External MCP servers: ${servers.map(server => server.name).join(", ")} (configuration ${digest(servers)}).`] : []),
  ].join("\n");
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8); }
