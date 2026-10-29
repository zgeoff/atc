import { expect, test } from 'bun:test';
import { PROCEDURE_TRAITS } from '@atc/protocol';
import { GRANTED_METHOD_SCOPES } from './granted-method-scopes';

test('it opens no owner-only method to a session with atc access', () => {
  const opened = Object.keys(GRANTED_METHOD_SCOPES).filter(
    (method) => PROCEDURE_TRAITS.get(method)?.access === 'owner',
  );

  expect(opened).toStrictEqual([]);
});

test('it names only methods the daemon serves', () => {
  const unknown = Object.keys(GRANTED_METHOD_SCOPES).filter(
    (method) => !PROCEDURE_TRAITS.has(method),
  );

  expect(unknown).toStrictEqual([]);
});

test('it closes the methods that read the daemon host or the whole fleet', () => {
  expect(Object.keys(GRANTED_METHOD_SCOPES)).not.toIncludeAnyMembers([
    'dirs.list',
    'sources.list',
    'sources.interpret',
    'sources.complete',
    'git.probe',
    'fleet.list',
    'session.input',
    'session.attach',
    'session.tap',
    'permission.respond',
  ]);
});
