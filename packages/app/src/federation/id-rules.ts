// `cursor` is left for the event merge to replace; `keep` passes a value that looks like an
// id but is none of atc's, still rewriting ruled fields below it; `opaque` passes it unread
export type IDRule = 'id' | 'locator' | 'cursor' | 'keep' | 'opaque';

// The fields of a session descriptor, relative to the descriptor.
const DESCRIPTOR_RULES: readonly (readonly [string, IDRule])[] = [
  ['id', 'id'],
  ['parent', 'id'],
  ['children[]', 'id'],
  ['locator', 'locator'],
  ['agentSessionID', 'keep'],
];

// by field path: object keys joined with `.`, and `[]` for every element of an array
export const ID_RULES: Readonly<Record<string, ReadonlyMap<string, IDRule>>> = {
  'agents.list': new Map(),
  'dirs.list': new Map([['dirs', 'opaque']]),
  'session.read': new Map([
    ['rows', 'opaque'],
    ['cursor', 'opaque'],
  ]),
  'session.screen': new Map([['text', 'opaque']]),
  'session.menu': new Map([['menu', 'opaque']]),
  'session.choose': new Map([['menu', 'opaque']]),
  'session.resumeCommand': new Map([['command', 'opaque']]),
  'session.submit': new Map(),
  'session.update': new Map(),
  'session.kill': new Map(),
  'session.ack': new Map(),
  'session.adopt': new Map(),
  'session.auth.rebind': new Map([['restartPending[]', 'id']]),
  'session.forget': new Map([['confirmToken', 'opaque']]),
  'session.list': buildPrefixedRules('sessions[].', DESCRIPTOR_RULES),
  'session.spawn': buildPrefixedRules('session.', DESCRIPTOR_RULES),
  'session.get': new Map([
    ...buildPrefixedRules('session.', DESCRIPTOR_RULES),
    ['sessionRecord.session', 'id'],
    ['sessionRecord.daemonID', 'opaque'],
  ]),
  'session.scope.add': new Map([
    ['record.session', 'id'],
    ['record.daemonID', 'opaque'],
  ]),
  'session.message': new Map([['message', 'id']]),
  'message.get': new Map([
    ['message', 'id'],
    ['session', 'id'],
    ['answeredWith[]', 'id'],
    ['from', 'opaque'],
    ['sender.session', 'id'],
    ['sender.client', 'opaque'],
    ['sender.name', 'opaque'],
    ['turn', 'keep'],
    ['turn.session', 'id'],
  ]),
  'message.ack': new Map([['message', 'id']]),
  'note.get': new Map([
    ['note', 'id'],
    ['session', 'id'],
    ['text', 'opaque'],
  ]),
  'answer.get': new Map([
    ['answer', 'id'],
    ['session', 'id'],
    ['message', 'id'],
    ['text', 'opaque'],
  ]),
  'events.read': new Map([
    ['events[].session', 'id'],
    ['events[].message', 'id'],
    ['events[].parent', 'id'],
    ['events[].note', 'id'],
    ['events[].answer', 'id'],
    ['events[].cursor', 'cursor'],
    ['cursor', 'cursor'],
  ]),
};

export const ERROR_DATA_RULES: ReadonlyMap<string, IDRule> = new Map([
  ['effectRef', 'id'],
  ['session', 'id'],
  ['message', 'id'],
  ['parent', 'id'],
  ['host', 'id'],
]);

function buildPrefixedRules(
  prefix: string,
  rules: readonly (readonly [string, IDRule])[],
): ReadonlyMap<string, IDRule> {
  return new Map(rules.map(([path, rule]) => [`${prefix}${path}`, rule]));
}
