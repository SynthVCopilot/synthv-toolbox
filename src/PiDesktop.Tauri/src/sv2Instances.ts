import type { Sv2ProfileSlot, Sv2ProfilesState, SynthVProcess } from "./types";

export function instanceProjectTitle(value: string | undefined): string {
  const title = value?.trim() ?? "";
  if (!title) return "未命名工程";
  return title
    .replace(/^\*\s*/u, "")
    .replace(/\s+[—-]\s+Synthesizer V Studio(?: 2)? Pro.*$/iu, "")
    .replace(/\s+·\s+Synthesizer V Studio.*$/iu, "")
    .trim() || "未命名工程";
}

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
