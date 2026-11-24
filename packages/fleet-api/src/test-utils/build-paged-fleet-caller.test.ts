import { expect, test } from 'bun:test';
import { buildPagedFleetCaller } from './build-paged-fleet-caller';

test('it answers each request with the next page and then rejects', async () => {
  const caller = buildPagedFleetCaller([{ cursor: 'a' }, { cursor: 'b' }]);

  const first = await caller.sendRequest('events.read');
  const second = await caller.sendRequest('events.read');

  expect([first, second]).toStrictEqual([{ cursor: 'a' }, { cursor: 'b' }]);
  expect(caller.sendRequest('events.read')).rejects.toThrow('queued no page');
});
