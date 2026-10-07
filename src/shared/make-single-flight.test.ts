import { expect, mock, test } from 'bun:test';
import { makeSingleFlight } from './make-single-flight';

test('it shares one run between calls that overlap', async () => {
  const gate = Promise.withResolvers<void>();
  let runs = 0;

  const once = makeSingleFlight(async () => {
    runs += 1;

    await gate.promise;

    return runs;
  });

  const first = once();
  const second = once();

  gate.resolve();

  const results = await Promise.all([first, second]);

  expect(results).toStrictEqual([1, 1]);
});

test('it starts a fresh run once the previous one has settled', async () => {
  let runs = 0;

  const once = makeSingleFlight(() => {
    runs += 1;

    return Promise.resolve(runs);
  });

  await once();

  const second = await once();

  expect(second).toBe(2);
});

test('it rejects the call with the error of a run that rejects', () => {
  const once = makeSingleFlight(() => Promise.reject(new Error('first run fails')));

  expect(once()).rejects.toThrowWithMessage(Error, 'first run fails');
});

test('it starts a fresh run after the previous one rejected', async () => {
  const run = mock<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('first run fails'))
    .mockResolvedValueOnce('second run');

  const once = makeSingleFlight(run);

  await once().catch(() => null);

  const second = await once();

  expect(second).toBe('second run');
});
