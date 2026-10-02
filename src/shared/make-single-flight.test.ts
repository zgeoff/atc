import { expect, test } from 'bun:test';
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

  const once = makeSingleFlight(async () => {
    runs += 1;

    await Bun.sleep(0);

    return runs;
  });

  await once();

  const second = await once();

  expect(second).toBe(2);
});

test('it starts a fresh run after the previous one rejected', async () => {
  const runs = [
    async () => {
      await Bun.sleep(0);

      throw new Error('first run fails');
    },
    async () => {
      await Bun.sleep(0);

      return 'second run';
    },
  ];

  const once = makeSingleFlight(() => {
    const run = runs.shift();

    if (run === undefined) {
      throw new Error('no run left');
    }

    return run();
  });

  const first = once();

  expect(first).rejects.toThrow('first run fails');

  await first.catch(() => null);

  const second = await once();

  expect(second).toBe('second run');
});
