import { expect, mock, test } from 'bun:test';
import { registerTestCleanup, waitFor } from '@atc/test-utils';
import { createActor } from 'xstate';
import type { SubscriptionRow } from './create-subscription-store';
import { createSubscriptionWatcherMachine } from './create-subscription-watcher-machine';

test('it reads the subscription again when a subscribe stored it during a read that found none', async () => {
  const read = Promise.withResolvers<SubscriptionRow | null>();

  const readSubscription = mock<(subscriptionID: string) => Promise<SubscriptionRow | null>>(
    () => read.promise,
  );

  const machine = createSubscriptionWatcherMachine({
    readSubscription,
    probeAccess: () => Promise.resolve(true),
    readTrail: () => Promise.reject(new Error('no trail')),
    deliverPage: () => Promise.resolve(),
    endSubscription: () => Promise.resolve(),
    log: () => {},
  });

  const actor = createActor(machine, { input: { subscriptionID: 'sub_one' } });

  actor.start();

  registerTestCleanup(() => actor.stop());

  actor.send({ type: 'WATCH' });
  read.resolve(null);

  await waitFor(() => {
    expect(actor.getSnapshot().status).toBe('done');
  });

  expect(readSubscription).toHaveBeenCalledTimes(2);
});

test('it ends after a read that finds no subscription', async () => {
  const readSubscription = mock<(subscriptionID: string) => Promise<SubscriptionRow | null>>(() =>
    Promise.resolve(null),
  );

  const machine = createSubscriptionWatcherMachine({
    readSubscription,
    probeAccess: () => Promise.resolve(true),
    readTrail: () => Promise.reject(new Error('no trail')),
    deliverPage: () => Promise.resolve(),
    endSubscription: () => Promise.resolve(),
    log: () => {},
  });

  const actor = createActor(machine, { input: { subscriptionID: 'sub_one' } });

  actor.start();

  registerTestCleanup(() => actor.stop());

  await waitFor(() => {
    expect(actor.getSnapshot().status).toBe('done');
  });

  expect(readSubscription).toHaveBeenCalledOnce();
});
