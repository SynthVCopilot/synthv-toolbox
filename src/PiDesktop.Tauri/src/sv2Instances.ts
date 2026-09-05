import type { Sv2ProfileSlot, Sv2ProfilesState, SynthVProcess } from "./types";

export function instanceAccount(
  process: Pick<SynthVProcess, "processId" | "isSv2" | "sandboxed">,
  profiles: Pick<Sv2ProfilesState, "slots" | "activeSlotId"> | undefined,
): { slot: Sv2ProfileSlot | undefined; mode: string } {
  const slots = profiles?.slots ?? [];
  const owners = slots.filter((slot) => slot.concurrent.runningPids.includes(process.processId));
  if (owners.length === 1) return { slot: owners[0], mode: "隔离并发" };
  if (owners.length > 1) return { slot: undefined, mode: "账号关联冲突" };
  if (process.isSv2 && process.sandboxed === false) {
    const slot = slots.find((slot) => slot.id === profiles?.activeSlotId);
    if (slot) return { slot, mode: "普通主槽" };
  }
  return { slot: undefined, mode: "未知环境" };
}
