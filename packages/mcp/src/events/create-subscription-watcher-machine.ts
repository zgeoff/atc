import type { EVENTS_PAGE_SCHEMA } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { machineTypes } from '@zgeoff/std';
import invariant from 'tiny-invariant';
import { assign, fromPromise, setup } from 'xstate';
import type { z } from 'zod';
import type { SubscriptionRow } from './create-subscription-store';

export type TrailPage = z.infer<typeof EVENTS_PAGE_SCHEMA>;

export interface PageDelivery {
  readonly subscriptionID: string;
  readonly page: TrailPage;
  readonly signal: AbortSignal;
}

export interface WatcherMachineDeps {
  // The subscription's row while it is live; null once it is gone.
  readonly readSubscription: (subscriptionID: string) => Promise<SubscriptionRow | null>;
  readonly probeAccess: (clientID: string) => Promise<boolean>;

  // Rejects with the cause when the daemon gives no page.
  readonly readTrail: (row: SubscriptionRow) => Promise<TrailPage>;

  // Stops between events once the signal aborts, so a stopped watcher
  // delivers nothing more and moves the position no further.
  readonly deliverPage: (delivery: PageDelivery) => Promise<void>;
  readonly endSubscription: (subscriptionID: string) => Promise<void>;
  readonly log: (line: string) => void;
}

interface WatcherContext {
  readonly subscriptionID: string;
  readonly row: SubscriptionRow | null;
  readonly page: TrailPage | null;
  readonly isReadFailing: boolean;

  // Whether a subscribe stored the row again since the watcher last read it.
  readonly isRenewed: boolean;
}

interface WatcherEvent {
  readonly type: 'WATCH';
}

interface FailureParams {
  readonly error: unknown;
}

interface ErrorEventArgs {
  readonly event: { readonly error: unknown };
}

// How long a watcher waits after a read the daemon could not answer.
const READ_RETRY_MS = 5000;

// The authorization server rotates a refresh token by revoking it and then
// storing its successor, in two writes, so a watcher that finds no grant with
// read checks again after this wait before it removes the subscription.
const ACCESS_RECHECK_MS = 5000;

// How long a watcher that failed waits before it starts again, so a failure
// that lasts, such as a position the store cannot write, posts no flood.
const RESTART_DELAY_MS = 30_000;

// One subscription's watcher reads the trail as the subscription's client,
// delivers each page, and ends once the subscription is gone.
export function createSubscriptionWatcherMachine(deps: WatcherMachineDeps) {
  const fail = {
    target: 'failed',
    actions: {
      type: 'logFailure',
      params: (args: ErrorEventArgs) => ({
        error: args.event.error,
      }),
    },
  } as const;

  return setup({
    types: machineTypes<{
      context: WatcherContext;
      events: WatcherEvent;
      input: { readonly subscriptionID: string };
    }>(),
    actors: {
      readSubscription: fromPromise<SubscriptionRow | null, string>((args) =>
        deps.readSubscription(args.input),
      ),
      probeAccess: fromPromise<boolean, string>((args) => deps.probeAccess(args.input)),
      readTrail: fromPromise<TrailPage, SubscriptionRow>((args) => deps.readTrail(args.input)),
      deliverPage: fromPromise<void, Omit<PageDelivery, 'signal'>>((args) =>
        deps.deliverPage({ ...args.input, signal: args.signal }),
      ),
      endSubscription: fromPromise<void, string>((args) => deps.endSubscription(args.input)),
    },
    guards: {
      isRenewed: (args) => args.context.isRenewed,
      isReadFailing: (args) => args.context.isReadFailing,
    },
    actions: {
      logFailure: (args, params: FailureParams) => {
        deps.log(
          `atc events: the watcher of ${args.context.subscriptionID} stopped: ${String(params.error)}`,
        );
      },
      logReadFailure: (args, params: FailureParams) => {
        deps.log(
          `atc events: the watcher of ${args.context.subscriptionID} cannot read the trail: ${String(params.error)}`,
        );
      },
      logCursorRefusal: (args, params: FailureParams) => {
        deps.log(
          `atc events: the trail refused the position of ${args.context.subscriptionID}, so the subscription ends: ${String(params.error)}`,
        );
      },
      logReadRecovery: (args) => {
        deps.log(`atc events: the watcher of ${args.context.subscriptionID} reads the trail again`);
      },
    },
    delays: {
      readRetryDelay: READ_RETRY_MS,
      accessRecheckDelay: ACCESS_RECHECK_MS,
      restartDelay: RESTART_DELAY_MS,
    },
  }).createMachine({
    id: 'subscription-watcher',
    initial: 'loading',
    context: (args) => ({
      subscriptionID: args.input.subscriptionID,
      row: null,
      page: null,
      isReadFailing: false,
      isRenewed: false,
    }),
    on: {
      WATCH: { actions: assign({ isRenewed: true }) },
    },
    states: {
      loading: {
        entry: assign({ isRenewed: false }),
        invoke: {
          // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
          src: 'readSubscription',
          input: (args) => args.context.subscriptionID,
          onDone: [
            {
              guard: (args) => args.event.output !== null,
              target: 'checkingAccess',
              actions: assign({ row: (args) => args.event.output }),
            },

            // a subscribe that stored the row while this read ran found the
            // watcher still running, so its watch started nothing
            { guard: 'isRenewed', target: 'loading', reenter: true },
            { target: 'ended' },
          ],
          onError: fail,
        },
      },
      checkingAccess: {
        invoke: {
          // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
          src: 'probeAccess',
          input: (args) => getRow(args.context).client_id,
          onDone: [
            { guard: (args) => args.event.output, target: 'reading' },
            { target: 'awaitingAccess' },
          ],
          onError: fail,
        },
      },
      awaitingAccess: {
        after: { accessRecheckDelay: 'recheckingAccess' },
      },
      recheckingAccess: {
        invoke: {
          // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
          src: 'probeAccess',
          input: (args) => getRow(args.context).client_id,
          onDone: [
            { guard: (args) => args.event.output, target: 'loading' },
            { target: 'removing' },
          ],
          onError: fail,
        },
      },
      removing: {
        invoke: {
          // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
          src: 'endSubscription',
          input: (args) => args.context.subscriptionID,
          onDone: [{ guard: 'isRenewed', target: 'loading' }, { target: 'ended' }],
          onError: fail,
        },
      },
      reading: {
        invoke: {
          // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
          src: 'readTrail',
          input: (args) => getRow(args.context),
          onDone: [
            {
              guard: 'isReadFailing',
              target: 'delivering',
              actions: [
                'logReadRecovery',
                assign({ page: (args) => args.event.output, isReadFailing: false }),
              ],
            },
            { target: 'delivering', actions: assign({ page: (args) => args.event.output }) },
          ],
          onError: [
            // A refused cursor stays refused, as after a daemon behind a
            // gateway starts a new incarnation, so the subscription ends and
            // the client's next subscribe starts again from its own cursor.
            {
              guard: (args) => isCursorRefusal(args.event.error),
              target: 'removing',
              actions: {
                type: 'logCursorRefusal',
                params: (args) => ({ error: args.event.error }),
              },
            },
            { guard: 'isReadFailing', target: 'awaitingRead' },
            {
              target: 'awaitingRead',
              actions: [
                { type: 'logReadFailure', params: (args) => ({ error: args.event.error }) },
                assign({ isReadFailing: true }),
              ],
            },
          ],
        },
      },
      awaitingRead: {
        after: { readRetryDelay: 'loading' },
      },
      delivering: {
        invoke: {
          // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
          src: 'deliverPage',
          input: (args) => ({
            subscriptionID: args.context.subscriptionID,
            page: getPage(args.context),
          }),
          onDone: 'loading',
          onError: fail,
        },
      },
      failed: {
        after: { restartDelay: 'loading' },
      },
      ended: {
        type: 'final',
      },
    },
  });
}

function getRow(context: WatcherContext): SubscriptionRow {
  invariant(context.row, 'a watcher reached a state that reads its row before it read one');

  return context.row;
}

function isCursorRefusal(error: unknown): boolean {
  return error instanceof DaemonError && error.code === 'bad_args';
}

function getPage(context: WatcherContext): TrailPage {
  invariant(context.page, 'a watcher began a delivery before it read a page');

  return context.page;
}
