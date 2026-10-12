import { expect, test } from 'bun:test';
import { collectUnruledIDPaths } from './collect-unruled-id-paths';

test('it finds an id in a field no rule covers', () => {
  const answer = {
    sessions: [
      {
        id: '2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c',
        origin: 'm-0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
        locator: { daemonID: '9a1b2c3d-0000-4000-8000-000000000001', targetID: 'local' },
      },
    ],
  };

  const rules = new Map([
    ['sessions[].id', 'id' as const],
    ['sessions[].locator', 'locator' as const],
  ]);

  expect(collectUnruledIDPaths(answer, rules)).toStrictEqual(['sessions[].origin']);
});

test('it finds nothing in an answer whose ids all have rules', () => {
  const answer = {
    session: '2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c',
    answeredWith: ['m-0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30'],
  };

  const rules = new Map([
    ['session', 'id' as const],
    ['answeredWith[]', 'id' as const],
  ]);

  expect(collectUnruledIDPaths(answer, rules)).toStrictEqual([]);
});

test('it counts everything below an opaque value as covered', () => {
  const answer = { rows: [{ text: 'resume 2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c' }] };

  expect(collectUnruledIDPaths(answer, new Map([['rows', 'opaque' as const]]))).toStrictEqual([]);
});

test('it skips strings that hold no id', () => {
  expect(collectUnruledIDPaths({ name: 'auth-bug', at: 5 }, new Map())).toStrictEqual([]);
});
