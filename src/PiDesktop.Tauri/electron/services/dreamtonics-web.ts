export const DREAMTONICS_PRODUCT_PAGE = "https://my.dreamtonics.com/my-products";
const API = "https://authr3.dreamtonics.com/api/v1/client";

export type WebAccountSnapshot = {
  status: "ready" | "loginRequired" | "error";
  use: "available" | "busy" | "unknown";
  offlineDevices: Array<{ name: string; enabled: boolean }>;
  licenses: Array<{ name: string; status: string; type: string }>;
  checkedAtUtc: string;
};

export interface WebAccountBrowser {
  open(): Promise<void>;
  authorization(): Promise<string | undefined>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  clear(): Promise<void>;
}

export class DreamtonicsWebAccounts {
  private readonly pending = new Map<string, Promise<WebAccountSnapshot>>();
  constructor(private readonly browser: (slotId: string) => WebAccountBrowser) {}

  async login(slotId: string): Promise<void> { await this.browser(slotId).open(); }
  async forget(slotId: string): Promise<void> { await this.browser(slotId).clear(); }

  inspect(slotId: string): Promise<WebAccountSnapshot> {
    const existing = this.pending.get(slotId);
    if (existing) return existing;
    const request = this.query(this.browser(slotId)).finally(() => this.pending.delete(slotId));
    this.pending.set(slotId, request);
    return request;
  }

  private async query(browser: WebAccountBrowser): Promise<WebAccountSnapshot> {
    const result: WebAccountSnapshot = { status: "error", use: "unknown", offlineDevices: [], licenses: [], checkedAtUtc: new Date().toISOString() };
    const authorization = await browser.authorization();
    if (!authorization) return { ...result, status: "loginRequired" };
    const request = async (path: string, method = "GET") => {
      const response = await browser.fetch(`${API}/${path}`, { method, headers: { Authorization: authorization, Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(10000) });
      if (response.status === 401) throw new Error("loginRequired");
      const body: unknown = await response.json().catch(() => undefined);
      return { ok: response.ok && record(body)?.status === 200, httpOk: response.ok, body: record(body) };
    };
    try {
      const [licenses, devices] = await Promise.all([request("my_licenses"), request("my_devices")]);
      const deviceData = record(devices.body?.data);
      if (!licenses.ok || !devices.ok || !Array.isArray(licenses.body?.data) || !Array.isArray(deviceData?.offline_license_devices)) return result;
      result.licenses = licenses.body.data.flatMap((value: unknown) => {
        const license = record(value), product = record(license?.product);
        return product && typeof product.name === "string" && typeof license?.status === "string" ? [{ name: product.name, status: license.status, type: typeof license.license_type === "string" ? license.license_type : "" }] : [];
      });
      result.offlineDevices = deviceData.offline_license_devices.flatMap((value: unknown) => {
        const device = record(value);
        return typeof device?.offline_license_enabled === "boolean" ? [{ name: typeof device.device_name === "string" ? device.device_name : "", enabled: device.offline_license_enabled }] : [];
      });
      const enrollment = await request("test_enroll", "POST");
      if (enrollment.ok || (enrollment.httpOk && !enrollment.body)) {
        const cleanup = await request("test_quit", "POST");
        if (record(enrollment.body?.data)?.status === "success" && cleanup.ok && record(cleanup.body?.data)?.status === "success") {
          result.status = "ready";
          result.use = "available";
        }
      } else if (containsBusyError(enrollment.body)) {
        result.status = "ready";
        result.use = "busy";
      }
    } catch (error) {
      if (error instanceof Error && error.message === "loginRequired") result.status = "loginRequired";
    }
    result.checkedAtUtc = new Date().toISOString();
    return result;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function containsBusyError(value: unknown): boolean {
  if (typeof value === "string") return ["device-concurrent-session-exceeded", "device-require-session-kickout-confirmation"].includes(value);
  if (Array.isArray(value)) return value.some(containsBusyError);
  return value !== null && typeof value === "object" && Object.values(value).some(containsBusyError);
}
