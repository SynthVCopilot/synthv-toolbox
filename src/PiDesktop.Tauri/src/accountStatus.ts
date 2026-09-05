export type AccountSessionStatus = "ready" | "missing" | "inUse" | "expired" | "loginRequired" | "invalid" | "syncFailed" | "accountMismatch" | "unsupported" | "offline";
export type AccountRemoteUse = "clear" | "detected" | "unknown";
export type AccountAuthorization = "verified" | "unknown";

export interface AccountEnvironmentInput {
  launchEnabled: boolean;
  localBlocked: boolean;
  sessionStatus: AccountSessionStatus;
  remoteUse: AccountRemoteUse;
  authorizationStatus: AccountAuthorization;
}

export interface AccountEnvironmentAvailability {
  available: boolean;
  busy: boolean;
  unavailable: boolean;
}

export interface AccountAvailabilitySummary {
  available: boolean;
  busy: boolean;
  allUnavailable: boolean;
}

export function evaluateAccountEnvironment(input: AccountEnvironmentInput): AccountEnvironmentAvailability {
  const sessionReady = input.sessionStatus === "ready" || input.sessionStatus === "inUse";
  const remoteBlocked = input.remoteUse === "detected";
  const available = input.launchEnabled
    && !input.localBlocked
    && !remoteBlocked
    && sessionReady
    && input.authorizationStatus === "verified";
  return {
    available,
    busy: input.sessionStatus === "inUse" || remoteBlocked || input.localBlocked,
    unavailable: !available && (!input.launchEnabled || input.localBlocked || remoteBlocked || !sessionReady || input.authorizationStatus !== "verified"),
  };
}

export function summarizeAccountEnvironments(inputs: AccountEnvironmentInput[]): AccountAvailabilitySummary {
  const states = inputs.map(evaluateAccountEnvironment);
  return {
    available: states.some((state) => state.available),
    busy: states.some((state) => state.busy),
    allUnavailable: states.length > 0 && states.every((state) => state.unavailable),
  };
}
