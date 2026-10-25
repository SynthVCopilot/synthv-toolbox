/**
 * Product identity for the Electron host. The renderer mirrors these values in src/brand.ts and
 * test/contract/services/toneshuttle-integrations.test.mjs keeps both in step with electron-builder.yml and electron/assets/installer.nsh.
 */
export const BRAND = {
  productName: "Toneshuttle",
  productNameZh: "声梭",
  /** Stable machine name for MCP serverInfo, client config keys and agent identity. */
  slug: "toneshuttle",
  tagline: "Vocal & audio creation toolbox",
  repositoryUrl: "https://github.com/SynthVCopilot/synthv-toolbox",
} as const;

/** File and folder names on disk. Installs made under the old names are moved here on upgrade. */
export const FILE_NAMES = {
  /** Folder under the OS app-data directory holding credentials, settings, plugins and agent state. */
  userDataDirectory: "Toneshuttle",
  /** Per-user install folder under %LOCALAPPDATA%\Programs; electron/assets/installer.nsh moves old installs here. */
  windowsInstallDirectory: "Toneshuttle",
  windowsExecutable: "Toneshuttle.exe",
} as const;

/** The product name before the rename, shown where users must recognise the old app. */
export const LEGACY_PRODUCT_NAME = "Synthesizer V Toolbox";

/** The same names under the previous "Synthesizer V Toolbox" product; only migrations read them. */
export const LEGACY_FILE_NAMES = {
  userDataDirectory: "synthv-toolbox",
  windowsInstallDirectory: "synthv-toolbox",
  windowsExecutable: "Synthesizer V Toolbox.exe",
} as const;

/**
 * Identifiers that must never change: the installer finds existing installs by its GUID, macOS and the signing
 * center know the app by its id, and the package name fixes app.name, which names the launch-at-login entry and
 * the macOS keychain item that protects the SV2 account web sessions.
 */
export const STABLE_IDENTIFIERS = {
  appId: "com.synthvcopilot.toolbox",
  /** NSIS upgrade code derived from appId; pinned in electron-builder.yml so upgrades stay in place. */
  nsisGuid: "361d7bfe-b0de-50d8-b042-ed469511f1fa",
  packageName: "synthv-toolbox",
} as const;
