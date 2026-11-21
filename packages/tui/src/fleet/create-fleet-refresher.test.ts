import { expect, test } from 'bun:test';
import { waitFor } from '@zgeoff/testing';
import { createFleetMirror } from './create-fleet-mirror';
import { createFleetRefresher } from './create-fleet-refresher';

function setupTest() {
  const mirror = createFleetMirror(null);
  const gate = Promise.withResolvers<void>();

  const answers: Readonly<Record<string, unknown>>[] = [
    { fleet: [{ sessionID: 's-1', name: 'first' }] },
    { fleet: [{ sessionID: 's-2', name: 'second' }] },
  ];

  let reads = 0;
  let redraws = 0;

  const client = {
    sendRequest: async (): Promise<Readonly<Record<string, unknown>>> => {
      const answer = answers[reads] ?? {};

      reads += 1;

      await gate.promise;

      return answer;
    },
  };

  const refresher = createFleetRefresher({
    mirror,
    readClient: () => client,
    onRefreshed: () => {
      redraws += 1;
    },
  });

  return {
    mirror,
    refresher,
    open: () => gate.resolve(),
    readCounts: () => ({ reads, redraws }),
  };
}

test('it reads the fleet once more after a read that refreshes asked for during it', async () => {
  const ctx = setupTest();

  ctx.refresher.refresh();
  ctx.refresher.refresh();
  ctx.refresher.refresh();
  ctx.open();

  await waitFor(() => {
    expect(ctx.readCounts()).toStrictEqual({ reads: 2, redraws: 2 });
  });

  expect(ctx.mirror.fleet).toStrictEqual([{ sessionID: 's-2', exited: false }]);
});

test('it reads the fleet when asked after the last read settled', async () => {
  const ctx = setupTest();

  ctx.open();
  ctx.refresher.refresh();

  await waitFor(() => {
    expect(ctx.readCounts()).toStrictEqual({ reads: 1, redraws: 1 });
  });

  ctx.refresher.refresh();

  await waitFor(() => {
    expect(ctx.readCounts()).toStrictEqual({ reads: 2, redraws: 2 });
  });
});
