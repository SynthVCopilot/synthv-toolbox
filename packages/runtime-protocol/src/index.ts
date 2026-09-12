/** A JSON-compatible value that can safely travel in an RPC envelope. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ApiVersion = `${number}.${number}`;

export const PROTOCOL_VERSION: ApiVersion = "1.0";

export const HOST_API_VERSION: ApiVersion = "1.0";

export interface VersionRange {
  min: ApiVersion;
  max: ApiVersion;
}

export const PROTOCOL_VERSION_RANGE: VersionRange = {
  min: PROTOCOL_VERSION,
  max: PROTOCOL_VERSION,
};

export interface CapabilityDescriptor {
  id: string;
  version: ApiVersion;
  operations: string[];
}

export interface RuntimeHello {
  runtimeId: string;
  protocol: VersionRange;
  capabilities: CapabilityDescriptor[];
}

export interface HostHello {
  hostId: string;
  protocol: VersionRange;
  capabilities: CapabilityDescriptor[];
}

export interface RpcRequest {
  kind: "request";
  id: string;
  protocolVersion: ApiVersion;
  method: string;
  params: JsonValue;
}

export interface RpcResponseSuccess {
  kind: "response";
  id: string;
  protocolVersion: ApiVersion;
  ok: true;
  result: JsonValue;
}

export interface RpcError {
  code: string;
  message: string;
  data?: JsonValue;
}

export interface RpcResponseFailure {
  kind: "response";
  id: string;
  protocolVersion: ApiVersion;
  ok: false;
  error: RpcError;
}

export interface RpcNotification {
  kind: "notification";
  protocolVersion: ApiVersion;
  event: string;
  params: JsonValue;
}

export type RpcMessage = RpcRequest | RpcResponseSuccess | RpcResponseFailure | RpcNotification;

export const HOST_HELLO_METHOD = "host.hello";
export const RUNTIME_HELLO_METHOD = "runtime.hello";

export type PluginPermission =
  | "agent.tools"
  | "host.read"
  | "host.execute"
  | "project.read"
  | "project.write";

export type PluginActionLocation =
  | "home.toolbar"
  | "project.toolbar"
  | "project.context"
  | "conversation.toolbar";

export interface PluginBackend {
  entry: string;
}

export interface PluginPageContribution {
  id: string;
  title: string;
  entry: string;
  icon?: string;
}

export interface PluginActionContribution {
  id: string;
  location: PluginActionLocation;
  title: string;
  icon?: string;
  whenCapability?: string;
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  hostApi: VersionRange;
  backend?: PluginBackend;
  pages?: PluginPageContribution[];
  actions?: PluginActionContribution[];
  permissions: PluginPermission[];
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const identifierPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const contributionIdPattern = /^[a-z][a-z0-9-]*$/;
const permittedActions = new Set<PluginActionLocation>([
  "home.toolbar",
  "project.toolbar",
  "project.context",
  "conversation.toolbar",
]);
const permittedPermissions = new Set<PluginPermission>([
  "agent.tools",
  "host.read",
  "host.execute",
  "project.read",
  "project.write",
]);

export function parseApiVersion(value: string): ApiVersion | undefined {
  return versionPattern.test(value) ? value as ApiVersion : undefined;
}

export function compareApiVersions(left: ApiVersion, right: ApiVersion): number {
  const [leftMajor, leftMinor] = left.split(".").map(Number);
  const [rightMajor, rightMinor] = right.split(".").map(Number);
  if (leftMajor !== rightMajor) return leftMajor - rightMajor;
  return leftMinor - rightMinor;
}

export function negotiateProtocolVersion(left: VersionRange, right: VersionRange): ApiVersion | undefined {
  const lower = compareApiVersions(left.min, right.min) >= 0 ? left.min : right.min;
  const upper = compareApiVersions(left.max, right.max) <= 0 ? left.max : right.max;
  return compareApiVersions(lower, upper) <= 0 ? upper : undefined;
}

export function isHostApiCompatible(manifest: PluginManifest, hostApiVersion: ApiVersion = HOST_API_VERSION): boolean {
  return compareApiVersions(manifest.hostApi.min, hostApiVersion) <= 0
    && compareApiVersions(hostApiVersion, manifest.hostApi.max) <= 0;
}

export function encodeJsonl(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseJsonl(line: string): RpcMessage {
  if (line.includes("\n") || line.includes("\r")) {
    throw new Error("JSONL input must contain exactly one line.");
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("JSONL input is not valid JSON.");
  }

  const message = validateRpcMessage(value);
  if (!message) throw new Error("JSONL input is not a valid RPC message.");
  return message;
}

export function validateRpcMessage(value: unknown): RpcMessage | undefined {
  if (!isRecord(value) || !isApiVersion(value.protocolVersion) || typeof value.kind !== "string") return undefined;

  if (value.kind === "request") {
    if (isNonEmptyString(value.id) && isNonEmptyString(value.method) && isJsonValue(value.params)) {
      return { kind: "request", id: value.id, protocolVersion: value.protocolVersion, method: value.method, params: value.params };
    }
    return undefined;
  }

  if (value.kind === "notification") {
    if (isNonEmptyString(value.event) && isJsonValue(value.params)) {
      return { kind: "notification", protocolVersion: value.protocolVersion, event: value.event, params: value.params };
    }
    return undefined;
  }

  if (value.kind === "response" && isNonEmptyString(value.id) && typeof value.ok === "boolean") {
    if (value.ok && isJsonValue(value.result)) {
      return { kind: "response", id: value.id, protocolVersion: value.protocolVersion, ok: true, result: value.result };
    }
    if (!value.ok && isRpcError(value.error)) {
      return { kind: "response", id: value.id, protocolVersion: value.protocolVersion, ok: false, error: value.error };
    }
  }

  return undefined;
}

export function validatePluginManifest(value: unknown): PluginManifest | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isPluginIdentifier(value.id)
    || !isNonEmptyString(value.name)
    || typeof value.version !== "string"
    || !semverPattern.test(value.version)
    || !isVersionRange(value.hostApi)
    || !Array.isArray(value.permissions)) return undefined;

  const permissions = value.permissions.filter(isPluginPermission);
  if (permissions.length !== value.permissions.length || new Set(permissions).size !== permissions.length) return undefined;

  const backend = validatePluginBackend(value.backend);
  if (value.backend !== undefined && !backend) return undefined;
  const pages = validatePluginPages(value.pages);
  if (value.pages !== undefined && !pages) return undefined;
  const actions = validatePluginActions(value.actions);
  if (value.actions !== undefined && !actions) return undefined;

  return {
    schemaVersion: 1,
    id: value.id,
    name: value.name,
    version: value.version,
    hostApi: value.hostApi,
    ...(backend ? { backend } : {}),
    ...(pages ? { pages } : {}),
    ...(actions ? { actions } : {}),
    permissions,
  };
}

function validatePluginBackend(value: unknown): PluginBackend | undefined {
  if (!isRecord(value) || !isSafeRelativePath(value.entry)) return undefined;
  return { entry: value.entry };
}

function validatePluginPages(value: unknown): PluginPageContribution[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pages: PluginPageContribution[] = [];
  for (const page of value) {
    if (!isRecord(page) || !isContributionId(page.id) || !isNonEmptyString(page.title) || !isSafeRelativePath(page.entry)
      || (page.icon !== undefined && !isNonEmptyString(page.icon))) return undefined;
    pages.push({ id: page.id, title: page.title, entry: page.entry, ...(page.icon ? { icon: page.icon } : {}) });
  }
  return hasUniqueIds(pages) ? pages : undefined;
}

function validatePluginActions(value: unknown): PluginActionContribution[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: PluginActionContribution[] = [];
  for (const action of value) {
    if (!isRecord(action) || !isContributionId(action.id) || !isPluginActionLocation(action.location)
      || !isNonEmptyString(action.title)
      || (action.icon !== undefined && !isNonEmptyString(action.icon))
      || (action.whenCapability !== undefined && !isNonEmptyString(action.whenCapability))) return undefined;
    actions.push({
      id: action.id,
      location: action.location,
      title: action.title,
      ...(action.icon ? { icon: action.icon } : {}),
      ...(action.whenCapability ? { whenCapability: action.whenCapability } : {}),
    });
  }
  return hasUniqueIds(actions) ? actions : undefined;
}

function isVersionRange(value: unknown): value is VersionRange {
  return isRecord(value) && isApiVersion(value.min) && isApiVersion(value.max)
    && compareApiVersions(value.min, value.max) <= 0;
}

function isRpcError(value: unknown): value is RpcError {
  return isRecord(value) && isNonEmptyString(value.code) && isNonEmptyString(value.message)
    && (value.data === undefined || isJsonValue(value.data));
}

function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === "string" && permittedPermissions.has(value as PluginPermission);
}

function isPluginActionLocation(value: unknown): value is PluginActionLocation {
  return typeof value === "string" && permittedActions.has(value as PluginActionLocation);
}

function isPluginIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isContributionId(value: unknown): value is string {
  return typeof value === "string" && contributionIdPattern.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.startsWith("\\")
    && !value.includes("\\") && !value.split("/").includes("..");
}

function hasUniqueIds(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function isApiVersion(value: unknown): value is ApiVersion {
  return typeof value === "string" && parseApiVersion(value) !== undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
