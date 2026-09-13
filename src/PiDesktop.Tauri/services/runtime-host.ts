export type HostArguments = Record<string, unknown>;

export interface RuntimeHostState {
  loaded: boolean;
  configuration: HostArguments;
}

export interface RuntimeHost {
  load(args?: HostArguments): Promise<RuntimeHostState>;
  configure(args: HostArguments): Promise<RuntimeHostState>;
  invoke(command: string, args: HostArguments): Promise<unknown>;
}

export function createRuntimeHost(): RuntimeHost {
  let state: RuntimeHostState = { loaded: false, configuration: {} };

  const load = async (args: HostArguments = {}) => {
    state = { loaded: true, configuration: { ...state.configuration, ...args } };
    return state;
  };

  return {
    load,
    async configure(args) {
      if (!state.loaded) await load();
      state = { ...state, configuration: { ...state.configuration, ...args } };
      return state;
    },
    async invoke(command, args) {
      if (!state.loaded) await load();
      return { accepted: false, command, args, reason: "The Electron runtime adapter has not been configured." };
    },
  };
}
