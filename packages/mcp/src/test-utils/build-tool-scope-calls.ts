import { FLEET_CONTRACT, LOCAL_FLEET_CONTRACT } from '@atcx/contract';

const NOTE_EVENT = {
  cursor: 'c1',
  at: 1,
  session: 's1',
  name: null,
  kind: 'note',
  label: 'l',
  detail: 'd',
};

const ANSWER_EVENT = {
  cursor: 'c2',
  at: 2,
  session: 's1',
  name: null,
  kind: 'message-answered',
  message: 'm-1',
  detail: 'd',
};

const LOCAL_PAGE = {
  events: [NOTE_EVENT, ANSWER_EVENT],
  cursor: 'c2',
  more: false,
};

const GATEWAY_PAGE = {
  events: [
    { ...NOTE_EVENT, origin: { daemon: 'build-box', incarnation: 'k3f9', cursor: 'c1' } },
    { ...ANSWER_EVENT, origin: { daemon: 'build-box', incarnation: 'k3f9', cursor: 'c2' } },
  ],
  cursor: 'c2',
  more: false,
  unavailable: [],
  started: [],
  truncated: [],
};

const GATEWAY = {
  contract: FLEET_CONTRACT,
  features: ['fleet.daemons'],
  page: GATEWAY_PAGE,
} as const;

const LOCAL = {
  contract: LOCAL_FLEET_CONTRACT,
  features: [],
  page: LOCAL_PAGE,
} as const;

type Served = typeof GATEWAY | typeof LOCAL;

export interface ToolScopeCall {
  readonly args: Readonly<Record<string, unknown>>;
  readonly served: Served;
  readonly methods: readonly string[];
}

const TOOL_CALLS: Readonly<Record<string, readonly ToolScopeCall[]>> = {
  atc_message_send: [
    {
      args: { session: 's1', text: 'hi' },
      served: GATEWAY,
      methods: ['session.message'],
    },
  ],
  atc_message_get: [{ args: { message: 'm1' }, served: GATEWAY, methods: ['message.get'] }],
  atc_terminal_type: [
    {
      args: { session: 's1', text: 'ls' },
      served: GATEWAY,
      methods: ['session.submit'],
    },
  ],
  atc_terminal_choose: [
    { args: { session: 's1' }, served: GATEWAY, methods: ['session.menu'] },
    {
      args: { session: 's1', menuToken: 't1', option: 1, label: 'Yes' },
      served: GATEWAY,
      methods: ['session.choose'],
    },
  ],
  atc_terminal_read: [{ args: { session: 's1' }, served: GATEWAY, methods: ['session.screen'] }],
  atc_session_get: [{ args: { session: 's1' }, served: GATEWAY, methods: ['session.get'] }],
  atc_transcript_read: [{ args: { session: 's1' }, served: GATEWAY, methods: ['session.read'] }],
  atc_events_read: [
    {
      args: {},
      served: GATEWAY,
      methods: ['events.read', 'note.get', 'answer.get'],
    },
    {
      args: {},
      served: LOCAL,
      methods: ['events.read', 'note.get', 'answer.get'],
    },
  ],
  atc_session_scope_add: [
    {
      args: { session: 's1', scope: 'read' },
      served: GATEWAY,
      methods: ['session.scope.add'],
    },
  ],
  atc_session_update: [
    {
      args: { session: 's1', name: 'worker' },
      served: GATEWAY,
      methods: ['session.update'],
    },
  ],
  atc_session_stop: [{ args: { session: 's1' }, served: GATEWAY, methods: ['session.kill'] }],
  atc_session_forget: [{ args: { session: 's1' }, served: GATEWAY, methods: ['session.forget'] }],
  atc_session_adopt: [{ args: { session: 's1' }, served: GATEWAY, methods: ['session.adopt'] }],
  atc_session_auth_rebind: [
    {
      args: { session: 's1' },
      served: LOCAL,
      methods: ['session.auth.rebind'],
    },
  ],
  atc_session_mark_read: [{ args: { session: 's1' }, served: GATEWAY, methods: ['session.ack'] }],
  atc_recent_dirs_list: [{ args: {}, served: GATEWAY, methods: ['dirs.list'] }],
  atc_daemons_list: [{ args: {}, served: GATEWAY, methods: ['daemons.list'] }],
  atc_spawn_options_get: [{ args: {}, served: GATEWAY, methods: ['agents.list'] }],
  atc_sessions_list: [{ args: {}, served: GATEWAY, methods: ['session.list'] }],
  atc_session_spawn: [
    { args: { cwd: '/work' }, served: GATEWAY, methods: ['session.spawn'] },
    { args: { cwd: '/work' }, served: LOCAL, methods: ['session.spawn'] },
  ],
};

// One call per contract that reaches each procedure of a tool, and the procedures it reaches.
export function buildToolScopeCalls(name: string): readonly ToolScopeCall[] {
  return TOOL_CALLS[name] ?? [];
}
