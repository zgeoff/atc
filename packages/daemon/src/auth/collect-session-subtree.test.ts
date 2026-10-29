import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { collectSessionSubtree } from './collect-session-subtree';

test("it collects a top-level session's sub-sessions and leaves the session itself out", () => {
  const subtree = collectSessionSubtree(
    [
      { id: toSessionID('lead'), parent: null, spawner: null },
      { id: toSessionID('worker'), parent: toSessionID('lead'), spawner: toSessionID('lead') },
      { id: toSessionID('added'), parent: toSessionID('lead'), spawner: null },
      { id: toSessionID('stranger'), parent: null, spawner: null },
    ],
    toSessionID('lead'),
  );

  expect([...subtree]).toIncludeSameMembers([toSessionID('worker'), toSessionID('added')]);
});

test('it collects the sessions a sub-session spawned beside it but not its siblings', () => {
  const subtree = collectSessionSubtree(
    [
      { id: toSessionID('coordinator'), parent: null, spawner: null },
      {
        id: toSessionID('agent'),
        parent: toSessionID('coordinator'),
        spawner: toSessionID('coordinator'),
      },
      {
        id: toSessionID('helper'),
        parent: toSessionID('coordinator'),
        spawner: toSessionID('agent'),
      },
      {
        id: toSessionID('sibling'),
        parent: toSessionID('coordinator'),
        spawner: toSessionID('coordinator'),
      },
    ],
    toSessionID('agent'),
  );

  expect([...subtree]).toStrictEqual([toSessionID('helper')]);
});

test('it collects the sessions spawned by the sessions in the subtree at any depth', () => {
  const subtree = collectSessionSubtree(
    [
      { id: toSessionID('deepest'), parent: toSessionID('lead'), spawner: toSessionID('middle') },
      { id: toSessionID('middle'), parent: toSessionID('lead'), spawner: toSessionID('agent') },
      { id: toSessionID('agent'), parent: toSessionID('lead'), spawner: null },
      { id: toSessionID('lead'), parent: null, spawner: null },
    ],
    toSessionID('agent'),
  );

  expect([...subtree]).toIncludeSameMembers([toSessionID('middle'), toSessionID('deepest')]);
});
