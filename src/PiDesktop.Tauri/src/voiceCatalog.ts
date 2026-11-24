import type { Sv2CachedVoice } from "./types";

function productNameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function findVoiceMetadata(
  name: string,
  productIds: readonly string[],
  catalog: readonly Sv2CachedVoice[],
): Sv2CachedVoice | undefined {
  const ids = new Set(productIds.map((id) => id.toLowerCase()));
  const matches = ids.size
    ? catalog.filter((item) => ids.has(item.id.toLowerCase()))
    : catalog.filter((item) => item.name && productNameKey(item.name) === productNameKey(name));
  return matches.length === 1 ? matches[0] : undefined;
}
