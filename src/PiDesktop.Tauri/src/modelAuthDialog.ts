type DialogElement = HTMLElement & Record<string, unknown>;

const actions = [
  "authorize-oauth", "reconnect-oauth", "add-api-key", "remove-oauth", "remove-api-key",
  "update-credential", "update-provider", "select-model", "update-provider-strategy", "refresh-catalog", "query-usage",
] as const;
export type ModelAuthAction = typeof actions[number];

interface Host {
  execute(action: ModelAuthAction, detail: unknown[], operationId?: string): Promise<void>;
  cancelAuthorization(operationId: string): Promise<unknown>;
  close(): void;
  updated(): void;
  formatError(reason: unknown): string;
}

export function mountModelAuthDialog(host: Host) {
  const element = document.createElement("model-auth-dialog") as DialogElement;
  element.open = false;
  document.body.append(element);
  let active: { controller: AbortController; operationId?: string } | undefined;

  function cancel() {
    const operation = active;
    active = undefined;
    operation?.controller.abort();
    element.busy = false;
    if (operation?.operationId) void host.cancelAuthorization(operation.operationId).catch(() => {});
  }

  function close() {
    if (!element.open) return;
    element.open = false;
    cancel();
    host.close();
  }

  element.addEventListener("close", close);
  for (const action of actions) {
    element.addEventListener(action, (event) => {
      event.stopPropagation();
      if (!element.open || active) return;
      const detail: unknown = (event as CustomEvent).detail;
      const operation = {
        controller: new AbortController(),
        operationId: action === "authorize-oauth" || action === "reconnect-oauth" ? crypto.randomUUID() : undefined,
      };
      active = operation;
      element.busy = true;
      element.error = null;
      void (async () => {
        try {
          await host.execute(action, Array.isArray(detail) ? detail : [detail], operation.operationId);
          if (active !== operation || operation.controller.signal.aborted) return;
          if (action === "select-model") close();
          host.updated();
        } catch (reason) {
          if (active === operation && !operation.controller.signal.aborted) element.error = host.formatError(reason);
        } finally {
          if (active === operation) {
            active = undefined;
            element.busy = false;
          }
        }
      })();
    });
  }

  return {
    update(properties: Record<string, unknown> & { open: boolean }) {
      if (!properties.open && element.open) cancel();
      if (properties.open && !element.open) element.error = null;
      const { open, ...configuration } = properties;
      Object.assign(element, configuration);
      element.open = open;
    },
    close,
    dispose() { cancel(); element.open = false; element.remove(); },
  };
}
