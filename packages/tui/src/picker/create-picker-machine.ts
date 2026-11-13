import { ansi } from '@atc/core';
import { machineTypes } from '@zgeoff/std';
import { P, match } from 'ts-pattern';
import { assertEvent, enqueueActions, raise, setup } from 'xstate';
import { drawPicker } from '../ui';
import { applyPickerKey } from './apply-picker-key';
import { applyRequestOutcome } from './apply-request-outcome';
import { buildPickerContext } from './build-picker-context';
import { buildPickerView } from './build-picker-view';
import type { CompletionOutcome, ListingOutcome, RequestOutcome } from './create-picker-actors';
import { createPickerActors } from './create-picker-actors';
import { openFirstStep } from './daemon-step';
import { applyCompletion, applyListing } from './list-step';
import { renderFlow, stopListings } from './navigate-picker';
import type {
  CompletionRequest,
  OnDaemon,
  PickerContext,
  PickerFlow,
  PickerRequest,
  SpawnPickerDeps,
} from './picker-flow';
import { getSelectedIndex } from './picker-queries';

const COMPLETION_DELAY_MS = 120;

type PickerEvent =
  | { readonly type: 'OPEN'; readonly resume: boolean }
  | { readonly type: 'KEY'; readonly buf: Buffer }
  | { readonly type: 'RENDER' }
  | { readonly type: 'STOP' }
  | { readonly type: 'CLOSE' }
  | { readonly type: 'REQUEST'; readonly request: OnDaemon<PickerRequest> }
  | { readonly type: 'REQUEST_DONE'; readonly outcome: RequestOutcome }
  | { readonly type: 'CANCEL_REQUEST' }
  | { readonly type: `xstate.done.actor.listing.${string}`; readonly output: ListingOutcome }
  | { readonly type: 'COMPLETE' }
  | { readonly type: 'COMPLETED'; readonly outcome: CompletionOutcome }
  | { readonly type: 'CANCEL_COMPLETION' };

export function createPickerMachine<TMirror extends { readonly id: string }>(
  deps: SpawnPickerDeps<TMirror>,
) {
  return setup({
    types: machineTypes<{ context: PickerContext; events: PickerEvent }>(),
    actors: createPickerActors(deps),
    delays: { completion: COMPLETION_DELAY_MS },
    actions: {
      step: enqueueActions((args) => {
        const event = args.event;
        const enqueue = args.enqueue;

        const base =
          event.type === 'OPEN'
            ? buildPickerContext(
                event.resume,
                deps.getLastUsedAgent(deps.primaryDaemon),
                deps.primaryDaemon,
                deps.readConfig().workspaces,
              )
            : args.context;

        const flow: PickerFlow = { ctx: { ...base }, effects: [], deps };

        applyEvent(flow, event);
        settleFlow(flow);

        enqueue.assign(() => ({ ...flow.ctx }));

        for (const effect of flow.effects) {
          match(effect)
            .with({ kind: 'request' }, (sent) => {
              enqueue.raise({
                type: 'REQUEST',
                request: { ...sent.request, daemon: flow.ctx.daemon },
              });
            })
            .with({ kind: 'cancel-request' }, () => {
              enqueue.raise({ type: 'CANCEL_REQUEST' });
            })
            .with({ kind: 'list' }, (listing) => {
              const id = toListingChildID(listing.request.sourceID);

              enqueue.stopChild(id);

              enqueue.spawnChild('listing', {
                id,
                input: { ...listing.request, daemon: flow.ctx.daemon },
              });
            })
            .with({ kind: 'cancel-listing' }, (cancel) => {
              enqueue.stopChild(toListingChildID(cancel.sourceID));
            })
            .with({ kind: 'complete' }, () => {
              enqueue.raise({ type: 'COMPLETE' });
            })
            .with({ kind: 'cancel-completion' }, () => {
              enqueue.raise({ type: 'CANCEL_COMPLETION' });
            })
            .with({ kind: 'render' }, (render) => {
              enqueue(() => {
                if (render.clear) {
                  deps.write(ansi.clear);
                }

                drawPicker(
                  buildPickerView({ ...render.ctx, selected: getSelectedIndex(render.ctx) }, deps),
                  deps.write,
                );

                deps.scheduleStatus();
              });
            })
            .with({ kind: 'quit' }, () => {
              enqueue.raise({ type: 'CLOSE' });

              enqueue(() => {
                deps.showBase();
              });
            })
            .with({ kind: 'stop' }, () => {
              enqueue.raise({ type: 'STOP' });
            })
            .with({ kind: 'attach' }, (attach) => {
              enqueue(() => {
                void deps.attach(attach.daemon, attach.sessionID);
              });
            })
            .with({ kind: 'show-base' }, () => {
              enqueue(() => {
                deps.showBase();
              });
            })
            .with({ kind: 'log' }, (log) => {
              enqueue(() => {
                deps.log?.(log.line);
              });
            })
            .exhaustive();
        }
      }),
      stopListings: enqueueActions((args) => {
        for (const source of args.context.sources) {
          args.enqueue.stopChild(toListingChildID(source.id));
        }
      }),
    },
  }).createMachine({
    id: 'spawn-picker',
    initial: 'closed',
    context: buildPickerContext(
      false,
      deps.getLastUsedAgent(deps.primaryDaemon),
      deps.primaryDaemon,
    ),
    on: {
      OPEN: { target: '.open', reenter: true, actions: 'step' },
      RENDER: { actions: 'step' },
    },
    states: {
      closed: {},
      open: {
        type: 'parallel',
        exit: 'stopListings',
        on: {
          CLOSE: '#spawn-picker.closed',
          KEY: { actions: 'step' },
          STOP: { actions: 'step' },
          REQUEST_DONE: { actions: 'step' },
          'xstate.done.actor.listing.*': { actions: 'step' },
          COMPLETED: { actions: 'step' },
        },
        states: {
          // Each region's transitions sit on its child states: one that
          // re-enters the region itself takes the machine root as its domain,
          // since SCXML skips a parallel state, and stops every region.
          request: {
            initial: 'idle',
            states: {
              idle: {
                on: { REQUEST: 'running' },
              },
              running: {
                on: {
                  REQUEST: { target: 'running', reenter: true },
                  CANCEL_REQUEST: 'idle',
                },
                invoke: {
                  // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
                  src: 'request',
                  input: (args) => {
                    assertEvent(args.event, 'REQUEST');

                    return args.event.request;
                  },
                  onDone: {
                    target: 'idle',
                    actions: raise((args) => ({
                      type: 'REQUEST_DONE',
                      outcome: args.event.output,
                    })),
                  },
                },
              },
            },
          },
          completion: {
            initial: 'idle',
            states: {
              idle: {
                on: { COMPLETE: 'waiting' },
              },
              waiting: {
                on: {
                  COMPLETE: { target: 'waiting', reenter: true },
                  CANCEL_COMPLETION: 'idle',
                },
                after: { completion: 'running' },
              },
              running: {
                on: {
                  COMPLETE: 'waiting',
                  CANCEL_COMPLETION: 'idle',
                },
                invoke: {
                  // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
                  src: 'completion',
                  input: (args) => ({
                    ...getCompletion(args.context),
                    daemon: args.context.daemon,
                  }),
                  onDone: {
                    target: 'idle',
                    actions: raise((args) => ({ type: 'COMPLETED', outcome: args.event.output })),
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

function applyEvent(flow: PickerFlow, event: PickerEvent) {
  match(event)
    .with({ type: 'OPEN' }, () => {
      openFirstStep(flow);
    })
    .with({ type: 'KEY' }, (key) => {
      applyPickerKey(flow, key.buf);
    })
    .with({ type: 'RENDER' }, () => {
      renderFlow(flow);
    })
    .with({ type: 'STOP' }, () => {
      stopFlow(flow);
    })
    .with({ type: 'REQUEST_DONE' }, (done) => {
      applyRequestOutcome(flow, done.outcome);
    })
    .with({ type: P.string.startsWith('xstate.done.actor.listing.') }, (done) => {
      applyListing(flow, done.output);
    })
    .with({ type: 'COMPLETED' }, (completed) => {
      applyCompletion(flow, completed.outcome);
    })
    .with(
      { type: 'CLOSE' },
      { type: 'REQUEST' },
      { type: 'CANCEL_REQUEST' },
      { type: 'COMPLETE' },
      { type: 'CANCEL_COMPLETION' },
      () => {},
    )
    .exhaustive();
}

function stopFlow(flow: PickerFlow) {
  const ctx = flow.ctx;

  stopListings(flow);

  ctx.pending = null;
  ctx.completion = null;

  flow.effects.push({ kind: 'cancel-request' }, { kind: 'cancel-completion' });
}

function settleFlow(flow: PickerFlow) {
  const ctx = flow.ctx;

  if (ctx.completion !== null && (ctx.step !== 'list' || ctx.input !== ctx.completion.input)) {
    ctx.completion = null;

    flow.effects.push({ kind: 'cancel-completion' });
  }

  ctx.selected = getSelectedIndex(ctx);
}

// Each source lists in a child of its own, so a listing of one source never
// stops another's, and a second listing of a source replaces its first.
function toListingChildID(sourceID: string) {
  return `listing.${sourceID}`;
}

function getCompletion(context: PickerContext): CompletionRequest {
  if (context.completion === null) {
    throw new Error('the completion region runs only with a completion to send');
  }

  return context.completion;
}
