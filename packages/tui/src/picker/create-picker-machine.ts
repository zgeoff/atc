import { ansi } from '@atc/core';
import { machineTypes } from '@zgeoff/std';
import { match } from 'ts-pattern';
import { assertEvent, enqueueActions, raise, setup } from 'xstate';
import { drawPicker } from '../ui';
import { openAgentMenu } from './agent-step';
import { applyPickerKey } from './apply-picker-key';
import { applyRequestOutcome } from './apply-request-outcome';
import { buildPickerContext } from './build-picker-context';
import { buildPickerView } from './build-picker-view';
import type {
  CompletionOutcome,
  GitListingOutcome,
  PathListingOutcome,
  RequestOutcome,
} from './create-picker-actors';
import { createPickerActors } from './create-picker-actors';
import { applyCompletion, applyPathListing } from './dir-step';
import { renderFlow } from './navigate-picker';
import type {
  CompletionRequest,
  GitListingRequest,
  PathListingRequest,
  PickerContext,
  PickerFlow,
  PickerRequest,
  SpawnPickerDeps,
} from './picker-flow';
import { findSource, getSelectedIndex } from './picker-queries';
import { applyGitListing } from './source-step';

// How long typing must pause before the flow asks the daemon to complete a
// typed path, so a burst of keys sends one request.
const COMPLETION_DELAY_MS = 120;

type PickerEvent =
  | { readonly type: 'OPEN'; readonly resume: boolean }
  | { readonly type: 'KEY'; readonly buf: Buffer }
  | { readonly type: 'RENDER' }
  | { readonly type: 'STOP' }
  | { readonly type: 'CLOSE' }
  | { readonly type: 'REQUEST'; readonly request: PickerRequest }
  | { readonly type: 'REQUEST_DONE'; readonly outcome: RequestOutcome }
  | { readonly type: 'CANCEL_REQUEST' }
  | { readonly type: 'LIST_PATH'; readonly request: PathListingRequest }
  | { readonly type: 'PATH_LISTED'; readonly outcome: PathListingOutcome }
  | { readonly type: 'CANCEL_PATH_LISTING' }
  | { readonly type: 'LIST_GIT'; readonly request: GitListingRequest }
  | { readonly type: 'GIT_LISTED'; readonly outcome: GitListingOutcome }
  | { readonly type: 'CANCEL_GIT_LISTING' }
  | { readonly type: 'COMPLETE' }
  | { readonly type: 'COMPLETED'; readonly outcome: CompletionOutcome }
  | { readonly type: 'CANCEL_COMPLETION' };

// Each request runs as an invoked actor that leaving its state stops, so an
// answer that comes after changes nothing.
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
                deps.getLastUsedAgent(),
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
              enqueue.raise({ type: 'REQUEST', request: sent.request });
            })
            .with({ kind: 'cancel-request' }, () => {
              enqueue.raise({ type: 'CANCEL_REQUEST' });
            })
            .with({ kind: 'list-path' }, (listing) => {
              enqueue.raise({ type: 'LIST_PATH', request: listing.request });
            })
            .with({ kind: 'cancel-path-listing' }, () => {
              enqueue.raise({ type: 'CANCEL_PATH_LISTING' });
            })
            .with({ kind: 'list-git' }, (listing) => {
              enqueue.raise({ type: 'LIST_GIT', request: listing.request });
            })
            .with({ kind: 'cancel-git-listing' }, () => {
              enqueue.raise({ type: 'CANCEL_GIT_LISTING' });
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
                void deps.attach(attach.sessionID);
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
    },
  }).createMachine({
    id: 'spawn-picker',
    initial: 'closed',
    context: buildPickerContext(false, deps.getLastUsedAgent()),
    on: {
      OPEN: { target: '.open', reenter: true, actions: 'step' },
      RENDER: { actions: 'step' },
    },
    states: {
      closed: {},
      open: {
        type: 'parallel',
        on: {
          CLOSE: '#spawn-picker.closed',
          KEY: { actions: 'step' },
          STOP: { actions: 'step' },
          REQUEST_DONE: { actions: 'step' },
          PATH_LISTED: { actions: 'step' },
          GIT_LISTED: { actions: 'step' },
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
          pathListing: {
            initial: 'idle',
            states: {
              idle: {
                on: { LIST_PATH: 'running' },
              },
              running: {
                on: {
                  LIST_PATH: { target: 'running', reenter: true },
                  CANCEL_PATH_LISTING: 'idle',
                },
                invoke: {
                  // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
                  src: 'pathListing',
                  input: (args) => {
                    assertEvent(args.event, 'LIST_PATH');

                    return args.event.request;
                  },
                  onDone: {
                    target: 'idle',
                    actions: raise((args) => ({ type: 'PATH_LISTED', outcome: args.event.output })),
                  },
                },
              },
            },
          },
          gitListing: {
            initial: 'idle',
            states: {
              idle: {
                on: { LIST_GIT: 'running' },
              },
              running: {
                on: {
                  LIST_GIT: { target: 'running', reenter: true },
                  CANCEL_GIT_LISTING: 'idle',
                },
                invoke: {
                  // oxlint-disable-next-line zgeoff/no-abbreviated-names -- xstate's invoke config names its actor src
                  src: 'gitListing',
                  input: (args) => {
                    assertEvent(args.event, 'LIST_GIT');

                    return args.event.request;
                  },
                  onDone: {
                    target: 'idle',
                    actions: raise((args) => ({ type: 'GIT_LISTED', outcome: args.event.output })),
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
                  input: (args) => getCompletion(args.context),
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

// Hands one event to the step module that owns it.
function applyEvent(flow: PickerFlow, event: PickerEvent) {
  match(event)
    .with({ type: 'OPEN' }, () => {
      openAgentMenu(flow);
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
    .with({ type: 'PATH_LISTED' }, (listed) => {
      applyPathListing(flow, listed.outcome);
    })
    .with({ type: 'GIT_LISTED' }, (listed) => {
      applyGitListing(flow, listed.outcome);
    })
    .with({ type: 'COMPLETED' }, (completed) => {
      applyCompletion(flow, completed.outcome);
    })
    .with(
      { type: 'CLOSE' },
      { type: 'REQUEST' },
      { type: 'CANCEL_REQUEST' },
      { type: 'LIST_PATH' },
      { type: 'CANCEL_PATH_LISTING' },
      { type: 'LIST_GIT' },
      { type: 'CANCEL_GIT_LISTING' },
      { type: 'COMPLETE' },
      { type: 'CANCEL_COMPLETION' },
      () => {},
    )
    .exhaustive();
}

// Ends every request the flow sent, so none changes anything when its answer
// comes, and keeps the step on screen.
function stopFlow(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.pending = null;
  ctx.listing = null;
  ctx.pathListing = false;
  ctx.completion = null;

  flow.effects.push(
    { kind: 'cancel-request' },
    { kind: 'cancel-path-listing' },
    { kind: 'cancel-git-listing' },
    { kind: 'cancel-completion' },
  );
}

// Drops what the step left behind: a git listing for a source the flow has
// left, so that source lists again when its step reopens, and a completion
// for text the directory step no longer shows.
function settleFlow(flow: PickerFlow) {
  const ctx = flow.ctx;

  if (ctx.listing !== null && findSource(ctx)?.id !== ctx.listing.sourceID) {
    ctx.listing = null;
    ctx.listedKey = null;

    flow.effects.push({ kind: 'cancel-git-listing' });
  }

  if (ctx.completion !== null && (ctx.step !== 'dir' || ctx.input !== ctx.completion.input)) {
    ctx.completion = null;

    flow.effects.push({ kind: 'cancel-completion' });
  }

  ctx.selected = getSelectedIndex(ctx);
}

function getCompletion(context: PickerContext): CompletionRequest {
  if (context.completion === null) {
    throw new Error('the completion region runs only with a completion to send');
  }

  return context.completion;
}
