import { expect, test } from 'bun:test';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { formatListPrompt } from './format-list-prompt';

test.each([
  {
    title: 'the kill question',
    kind: 'kill',
    session: { name: 'orders', canDestroyHost: false },
    subs: 0,
    expected: 'kill orders? · y / n',
  },
  {
    title: 'the end question that removes a session from the list',
    kind: 'end',
    session: { name: 'orders', canDestroyHost: false },
    subs: 0,
    expected: 'end orders? stops the agent and removes it from the list · y / n',
  },
  {
    title: 'the end question for a daemon that does not send canDestroyHost',
    kind: 'end',
    session: { name: 'orders', canDestroyHost: null },
    subs: 0,
    expected: 'end orders? stops the agent and removes it from the list · y / n',
  },
  {
    title: 'the end question that names the machine',
    kind: 'end',
    session: { name: 'orders', canDestroyHost: true, place: { key: 'k', label: 'sprite' } },
    subs: 0,
    expected:
      'end orders? stops the agent and deletes its sprite machine, with every session on it · y / n',
  },
  {
    title: 'the second end question, which always names the machine',
    kind: 'destroy',
    session: { name: 'orders', canDestroyHost: false, place: { key: 'k', label: 'sprite' } },
    subs: 0,
    expected:
      'end orders? stops the agent and deletes its sprite machine, with every session on it · y / n',
  },
  {
    title: 'one ended sub-session',
    kind: 'end',
    session: { name: 'orders', canDestroyHost: false },
    subs: 1,
    expected:
      'end orders? stops the agent and removes it from the list, and removes its 1 ended sub-session · y / n',
  },
  {
    title: 'two ended sub-sessions',
    kind: 'end',
    session: { name: 'orders', canDestroyHost: false },
    subs: 2,
    expected:
      'end orders? stops the agent and removes it from the list, and removes its 2 ended sub-sessions · y / n',
  },
] as const)('#formatListPrompt gives $title', (row) => {
  expect(formatListPrompt(row.kind, buildMockMirrorSession(row.session), row.subs)).toBe(
    row.expected,
  );
});
