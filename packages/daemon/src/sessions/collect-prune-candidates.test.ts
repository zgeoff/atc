import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { collectPruneCandidates } from './collect-prune-candidates';

test('it checks the newest ready row of a folder no session owns', () => {
  const candidates = collectPruneCandidates({
    rows: [
      {
        sessionID: toSessionID('first'),
        target: 'local',
        directory: '/w/bakery',
        phase: 'ready',
        sha: 'aaa',
      },
      {
        sessionID: toSessionID('second'),
        target: 'local',
        directory: '/w/bakery/',
        phase: 'ready',
        sha: 'bbb',
      },
      {
        sessionID: toSessionID('third'),
        target: 'local',
        directory: '/w/bakery',
        phase: 'failed',
        sha: null,
      },
    ],
    permanentTargets: new Set(['local']),
    listed: [],
    spawning: new Set(),
    rootFolders: [],
    stateFolders: [],
  });

  expect(candidates.workspaces).toStrictEqual([
    {
      sessionID: toSessionID('second'),
      target: 'local',
      directory: '/w/bakery/',
      phase: 'ready',
      sha: 'bbb',
    },
  ]);
});

test.each([
  {
    owner: 'a listed session of an older row',
    listed: [{ id: 'first', cwd: '/elsewhere' }],
    spawning: [],
  },
  {
    owner: 'a listed session that runs inside it',
    listed: [{ id: 'plain', cwd: '/w/bakery/src' }],
    spawning: [],
  },
  { owner: 'a spawn in flight of a newer row', listed: [], spawning: ['second'] },
])('it leaves out a folder that $owner owns', (row) => {
  const candidates = collectPruneCandidates({
    rows: [
      {
        sessionID: toSessionID('first'),
        target: 'local',
        directory: '/w/bakery',
        phase: 'ready',
        sha: 'aaa',
      },
      {
        sessionID: toSessionID('second'),
        target: 'local',
        directory: '/w/bakery',
        phase: 'resolving',
        sha: null,
      },
    ],
    permanentTargets: new Set(['local']),
    listed: row.listed.map((session) => ({
      id: toSessionID(session.id),
      cwd: session.cwd,
      onMachine: true,
    })),
    spawning: new Set(row.spawning.map((id) => toSessionID(id))),
    rootFolders: [],
    stateFolders: [],
  });

  expect(candidates.workspaces).toStrictEqual([]);
});

test('it ignores a row on a target outside the permanent ones', () => {
  const candidates = collectPruneCandidates({
    rows: [
      {
        sessionID: toSessionID('guest'),
        target: 'box',
        directory: '/w/bakery',
        phase: 'ready',
        sha: 'aaa',
      },
    ],
    permanentTargets: new Set(['local']),
    listed: [],
    spawning: new Set(),
    rootFolders: ['/w/bakery'],
    stateFolders: [],
  });

  expect(candidates).toStrictEqual({
    workspaces: [],
    skipped: [{ path: '/w/bakery', reason: 'no atc record' }],
    states: [],
  });
});

test.each([
  { folder: 'no row names', phases: [], skipped: [{ path: '/w/notes', reason: 'no atc record' }] },
  {
    folder: 'only an unfinished row names',
    phases: ['failed'],
    skipped: [{ path: '/w/notes', reason: 'atc never finished building it' }],
  },
  { folder: 'a ready row names', phases: ['ready'], skipped: [] },
])('it skips a folder under a root that $folder', (row) => {
  const candidates = collectPruneCandidates({
    rows: row.phases.map((phase) => ({
      sessionID: toSessionID('first'),
      target: 'local',
      directory: '/w/notes',
      phase,
      sha: null,
    })),
    permanentTargets: new Set(['local']),
    listed: [],
    spawning: new Set(),
    rootFolders: ['/w/notes', '/w/notes/'],
    stateFolders: [],
  });

  expect(candidates.skipped).toStrictEqual(row.skipped);
});

test('it checks a folder that only a session on another machine runs inside', () => {
  const candidates = collectPruneCandidates({
    rows: [
      {
        sessionID: toSessionID('first'),
        target: 'local',
        directory: '/w/bakery',
        phase: 'ready',
        sha: 'aaa',
      },
    ],
    permanentTargets: new Set(['local']),
    listed: [{ id: toSessionID('guest'), cwd: '/w/bakery', onMachine: false }],
    spawning: new Set(),
    rootFolders: [],
    stateFolders: [],
  });

  expect(candidates.workspaces).toStrictEqual([
    {
      sessionID: toSessionID('first'),
      target: 'local',
      directory: '/w/bakery',
      phase: 'ready',
      sha: 'aaa',
    },
  ]);
});

test('it takes the state folders of the sessions no one lists or spawns', () => {
  const candidates = collectPruneCandidates({
    rows: [],
    permanentTargets: new Set(['local']),
    listed: [{ id: toSessionID('listed'), cwd: '/w/bakery', onMachine: true }],
    spawning: new Set([toSessionID('spawning')]),
    rootFolders: [],
    stateFolders: ['listed', 'spawning', 'forgotten'],
  });

  expect(candidates.states).toStrictEqual([toSessionID('forgotten')]);
});
