import { createUsageGate, mergeUsageReading, type ProviderUsageSnapshot, type UsageGate } from "@model-auth/core";
import { queryProviderUsage, refreshAnthropic, refreshOpenAI, usageErrorSnapshot, usageSnapshot, type ProviderUsageCredential } from "@model-auth/providers";
import type { PiCredential, PiCredentialStore } from "@synthv-toolbox/agent-runtime";
import type { AiProviderId, ProviderUsagePort } from "./ai-service.js";

const READ_TIMEOUT_MS = 15_000;
/** Anthropic's usage endpoint rate-limits aggressively, so its readings are held longer. */
const MIN_INTERVAL_MS = { anthropic: 120_000, default: 60_000 } as const;

export interface UsageOptions {
  /** Credential access scoped to one stored account; never exposes other accounts or providers. */
  credentialStore(provider: AiProviderId, credentialId: string): PiCredentialStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  gate?: UsageGate;
}

type OAuthCredential = Extract<PiCredential, { type: "oauth" }>;

/** Reads subscription quota for stored OAuth accounts; providers without a usage surface report "unknown". */
export function createProviderUsage(options: UsageOptions): ProviderUsagePort {
  const now = options.now ?? Date.now;
  const gate = options.gate ?? createUsageGate({
    minIntervalMs: provider => provider === "anthropic" ? MIN_INTERVAL_MS.anthropic : MIN_INTERVAL_MS.default,
    lane: provider => provider === "anthropic" ? { concurrency: 1, minSpacingMs: 2_000 } : { concurrency: 2, minSpacingMs: 300 },
    maxConcurrent: 4,
    now,
  });
  const held = new Map<string, ProviderUsageSnapshot>();

  const read = async (provider: "anthropic" | "openai-codex", credentialId: string): Promise<ProviderUsageSnapshot> => {
    const store = options.credentialStore(provider, credentialId);
    const stored = await store.read(provider);
    if (stored?.type !== "oauth") return usageErrorSnapshot(provider, credentialId, new Error("The account has no OAuth login. Sign in again."));
    const credential = usageCredential(stored);
    const refresh = async () => {
      const renewed = await store.modify(provider, async current => {
        if (current?.type !== "oauth") return current;
        const next = provider === "anthropic" ? await refreshAnthropic(current, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }) : await refreshOpenAI(current, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
        return { ...current, ...next, type: "oauth" } as OAuthCredential;
      });
      return renewed?.type === "oauth" ? renewed.access : undefined;
    };
    try {
      return await queryProviderUsage(provider, credential, { credentialId, refresh, signal: AbortSignal.timeout(READ_TIMEOUT_MS), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    } catch (error) {
      return usageErrorSnapshot(provider, credentialId, error, held.get(credentialId)?.identity);
    }
  };

  const unknown = (provider: string, credentialId: string) => usageSnapshot(provider, credentialId, { status: "unknown", plan: null, windows: [], balance: null });

  return {
    async query(provider, credentialIds) {
      const accounts = await Promise.all(credentialIds.map(async credentialId => {
        if (provider !== "anthropic" && provider !== "openai-codex") return toRendererUsage(unknown(provider, credentialId));
        const result = await gate.run(credentialId, { providerId: provider, reason: "view" }, () => read(provider, credentialId));
        if (result.ran) {
          const merged = mergeUsageReading(held.get(credentialId), result.value, now());
          held.set(credentialId, merged);
          return toRendererUsage(merged);
        }
        return toRendererUsage(held.get(credentialId) ?? unknown(provider, credentialId));
      }));
      return { accounts };
    },
  };
}

function usageCredential(stored: OAuthCredential): ProviderUsageCredential {
  const text = (key: string) => typeof stored[key] === "string" && stored[key] ? stored[key] as string : undefined;
  const number = (key: string) => typeof stored[key] === "number" ? stored[key] as number : undefined;
  return {
    access: stored.access,
    ...(text("idToken") ? { idToken: text("idToken")! } : {}),
    ...(text("accountId") ? { accountId: text("accountId")! } : {}),
    ...(text("subscriptionType") ? { subscriptionType: text("subscriptionType")! } : {}),
    ...(text("billingInterval") ? { billingInterval: text("billingInterval")! } : {}),
    ...(number("subscriptionRenewsAt") === undefined ? {} : { subscriptionRenewsAt: number("subscriptionRenewsAt")! }),
    ...(number("subscriptionExpires") === undefined ? {} : { subscriptionExpires: number("subscriptionExpires")! }),
  };
}

/** The renderer's usage shape: windows and balance as the settings page draws them, plus plan and subscription dates. */
export function toRendererUsage(snapshot: ProviderUsageSnapshot): { credentialId: string; [key: string]: unknown } {
  return {
    providerId: snapshot.providerId,
    credentialId: snapshot.credentialId,
    status: snapshot.status,
    plan: snapshot.plan,
    planMultiplier: snapshot.planMultiplier ?? null,
    billingInterval: snapshot.billingInterval ?? null,
    subscriptionRenewsAt: snapshot.subscriptionRenewsAt ?? null,
    subscriptionExpiresAt: snapshot.subscriptionExpiresAt ?? null,
    metadataError: snapshot.metadataError ?? null,
    windows: snapshot.windows.map(window => ({
      id: window.id,
      label: window.label,
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent ?? (window.usedPercent === null ? null : 100 - window.usedPercent),
      resetAt: window.resetAt,
      used: window.used ?? null,
      limit: window.limit ?? null,
      remaining: window.remaining ?? null,
      unit: window.unit ?? null,
    })),
    balance: snapshot.balance ? { amount: snapshot.balance.amount, unit: snapshot.balance.unit } : null,
    estimate: null,
    fetchedAtUtc: snapshot.fetchedAtUtc,
    error: snapshot.error,
  };
}
