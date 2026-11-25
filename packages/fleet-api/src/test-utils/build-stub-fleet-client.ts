import type { FleetClient, FleetProcedure } from '../types';

interface StubFleetCall {
  readonly method: string;
  readonly input: Readonly<Record<string, unknown>>;
}

interface StubFleetClientConfig {
  readonly hasDaemons?: boolean;
}

export function buildStubFleetClient(config: StubFleetClientConfig = {}): {
  readonly client: FleetClient;
  readonly calls: readonly StubFleetCall[];
} {
  const calls: StubFleetCall[] = [];

  const at =
    (method: string): FleetProcedure =>
    (input) => {
      calls.push({ method, input });

      return Promise.resolve({});
    };

  const client: FleetClient = {
    agents: { list: at('agents.list') },
    dirs: { list: at('dirs.list') },
    ...(config.hasDaemons === true ? { daemons: { list: at('daemons.list') } } : {}),
    session: {
      list: at('session.list'),
      get: at('session.get'),
      spawn: at('session.spawn'),
      update: at('session.update'),
      ack: at('session.ack'),
      kill: at('session.kill'),
      forget: at('session.forget'),
      adopt: at('session.adopt'),
      submit: at('session.submit'),
      screen: at('session.screen'),
      menu: at('session.menu'),
      choose: at('session.choose'),
      read: at('session.read'),
      message: at('session.message'),
      scope: { add: at('session.scope.add') },
      auth: { rebind: at('session.auth.rebind') },
    },
    message: { get: at('message.get') },
    note: { get: at('note.get') },
    answer: { get: at('answer.get') },
    events: { read: at('events.read') },
  };

  return { client, calls };
}
