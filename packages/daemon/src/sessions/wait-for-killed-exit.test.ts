import { expect, test } from 'bun:test';
import { waitForKilledExit } from './wait-for-killed-exit';

test('it answers true, and forces nothing, when the killed harness exits within the wait', async () => {
  let forced = false;

  const exited = await waitForKilledExit(
    {
      waitForExit: () => Promise.resolve(true),
      killForced: () => {
        forced = true;
      },
    },
    1000,
  );

  expect({ exited, forced }).toStrictEqual({ exited: true, forced: false });
});

test('it ends a harness by force once the first wait runs out', async () => {
  let forced = false;

  const exited = await waitForKilledExit(
    {
      waitForExit: () => Promise.resolve(forced),
      killForced: () => {
        forced = true;
      },
    },
    1,
  );

  expect(exited).toBeTrue();
});

test('it answers false when the harness has no forced kill and never exits', async () => {
  const exited = await waitForKilledExit({ waitForExit: () => Promise.resolve(false) }, 1);

  expect(exited).toBeFalse();
});
