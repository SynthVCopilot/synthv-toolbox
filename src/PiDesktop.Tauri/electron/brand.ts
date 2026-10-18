/**
 * Product identity for the Electron host. The renderer mirrors these values in src/brand.ts and
 * test/brand-identity.mjs keeps both in step with electron-builder.yml.
 */
export const BRAND = {
  productName: "Toneshuttle",
  productNameZh: "声梭",
  /** Stable machine name for MCP serverInfo, client config keys and agent identity. */
  slug: "toneshuttle",
  tagline: "Vocal & audio creation toolbox",
  repositoryUrl: "https://github.com/SynthVCopilot/synthv-toolbox",
} as const;

/**
 * Identifiers that were chosen under the previous "Synthesizer V Toolbox" name and must not change:
 * existing installs keep their data, installer registration and update feed only while these stay fixed.
 */
export const STABLE_IDENTIFIERS = {
  /** Folder under the OS app-data directory holding credentials, settings, plugins and agent state. */
  userDataDirectory: "synthv-toolbox",
  appId: "com.synthvcopilot.toolbox",
  /** NSIS upgrade code derived from appId; pinned in electron-builder.yml so upgrades stay in place. */
  nsisGuid: "361d7bfe-b0de-50d8-b042-ed469511f1fa",
} as const;
