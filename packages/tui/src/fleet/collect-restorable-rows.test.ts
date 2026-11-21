import { expect, test } from 'bun:test';
import { collectRestorableRows } from './collect-restorable-rows';

test.each([
  {
    verdict: 'skips',
    title: 'a row whose session is listed live',
    fleet: [{ sessionID: 's-1', exited: false }],
    sessions: [{ daemon: null, id: 's-1', alive: true }],
    restorable: [],
  },
  {
    verdict: 'keeps',
    title: 'a row whose session is listed without a terminal',
    fleet: [{ sessionID: 's-1', exited: false }],
    sessions: [{ daemon: null, id: 's-1', alive: false }],
    restorable: ['s-1'],
  },
  {
    verdict: 'keeps',
    title: 'a row whose session is not listed',
    fleet: [{ sessionID: 's-1', exited: false }],
    sessions: [],
    restorable: ['s-1'],
  },
  {
    verdict: 'skips',
    title: 'an exited row whose session is listed',
    fleet: [{ sessionID: 's-1', exited: true }],
    sessions: [{ daemon: null, id: 's-1', alive: false }],
    restorable: [],
  },
  {
    verdict: 'keeps',
    title: 'an exited row whose session is not listed',
    fleet: [{ sessionID: 's-1', exited: true }],
    sessions: [],
    restorable: ['s-1'],
  },
  {
    verdict: 'keeps',
    title: 'a row whose session id is listed live only on another daemon',
    fleet: [{ sessionID: 's-1', exited: false }],
    sessions: [{ daemon: 'box', id: 's-1', alive: true }],
    restorable: ['s-1'],
  },
])('#collectRestorableRows $verdict $title', (row) => {
  expect(
    collectRestorableRows(row.fleet, row.sessions, null).map((entry) => entry.sessionID),
  ).toStrictEqual([...row.restorable]);
});
