/**
 * How the gateway treats one field of a daemon answer: `id` prefixes a
 * daemon id with the daemon's name and incarnation, `locator` replaces the
 * daemon ID in a session locator with the name and incarnation, `cursor`
 * is a daemon cursor the event merge replaces with a gateway cursor, and
 * `keep` passes a value that looks like an id but is none of atc's, such as
 * an agent's own session id.
 */
export type IDRule = 'id' | 'locator' | 'cursor' | 'keep';

// The fields of a session descriptor, relative to the descriptor.
const DESCRIPTOR_RULES: readonly (readonly [string, IDRule])[] = [
  ['id', 'id'],
  ['parent', 'id'],
  ['children[]', 'id'],
  ['locator', 'locator'],
  ['agentSessionID', 'keep'],
];

/**
 * The rule for every id-bearing field of each daemon method's answer, by
 * the field's path: object keys joined with `.`, and `[]` for every element
 * of an array. A method missing here answers with no id at all.
 */
export const ID_RULES: Readonly<Record<string, ReadonlyMap<string, IDRule>>> = {
  'session.list': buildPrefixedRules('sessions[].', DESCRIPTOR_RULES),
  'session.spawn': buildPrefixedRules('session.', DESCRIPTOR_RULES),
  'session.get': buildPrefixedRules('session.', DESCRIPTOR_RULES),
  'session.message': new Map([['message', 'id']]),
  'message.get': new Map([
    ['message', 'id'],
    ['session', 'id'],
    ['answeredWith[]', 'id'],
    ['turn', 'keep'],
    ['turn.session', 'id'],
  ]),
  'message.ack': new Map([['message', 'id']]),
  'events.read': new Map([
    ['events[].session', 'id'],
    ['events[].message', 'id'],
    ['events[].parent', 'id'],
    ['events[].report', 'id'],
    ['events[].cursor', 'cursor'],
    ['cursor', 'cursor'],
  ]),
};

/**
 * The rule for every id-bearing field of an error's `data`, whatever the
 * method: `effectRef` holds the session or message an uncertain or
 * conflicting keyed request made.
 */
export const ERROR_DATA_RULES: ReadonlyMap<string, IDRule> = new Map([
  ['effectRef', 'id'],
  ['session', 'id'],
  ['message', 'id'],
  ['parent', 'id'],
]);

function buildPrefixedRules(
  prefix: string,
  rules: readonly (readonly [string, IDRule])[],
): ReadonlyMap<string, IDRule> {
  return new Map(rules.map(([path, rule]) => [`${prefix}${path}`, rule]));
}
