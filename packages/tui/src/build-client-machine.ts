import { machineTypes } from '@zgeoff/std';
import { assign, setup } from 'xstate';
import type { Actor } from 'xstate';

export interface RestartConsent {
  readonly prompt: string;
  readonly answer: (key: string) => void;
}

type ClientMachineEvent =
  | { readonly type: 'ATTACH'; readonly sessionID: string }
  | { readonly type: 'HOME' }
  | { readonly type: 'OVERLAY' }
  | { readonly type: 'HELP' }
  | { readonly type: 'SPAWN'; readonly resume: boolean }
  | { readonly type: 'EJECT'; readonly sessionID: string }
  | { readonly type: 'CONFIRM_KILL' }
  | { readonly type: 'CONFIRM_DESTROY'; readonly sessionID: string }
  | { readonly type: 'CONFIRM_DONE' }
  | { readonly type: 'CONSENT_ASKED'; readonly consent: RestartConsent }
  | { readonly type: 'CONSENT_ANSWERED' }
  | { readonly type: 'DAEMON_LOST' }
  | { readonly type: 'DAEMON_READY' }
  | { readonly type: 'RESTART_STARTED' }
  | { readonly type: 'RESTART_AWAITING_FRESH'; readonly freshUntil: number }
  | { readonly type: 'RESTART_ENDED'; readonly connected: boolean };

interface ClientMachineContext {
  // The session whose kill the daemon refused until the operator confirms
  // that forgetting it destroys its host.
  readonly destroyID: string | null;

  // The restart prompt that waits for its key.
  readonly consent: RestartConsent | null;

  // Until this time, a restart refuses a daemon that still runs the old
  // build, so the client waits for the new one.
  readonly freshUntil: number;
}

// What the machine borrows from the client that owns the screen, the fleet
// mirror, and the daemon connection. Every prop is a side effect the machine
// triggers but never performs itself.
export interface ClientMachineDeps {
  readonly openHome: () => void;
  readonly openAttached: (sessionID: string) => void;
  readonly closeAttached: () => void;
  readonly openOverlay: () => void;
  readonly openHelp: () => void;
  readonly openPicker: (resume: boolean) => void;
  readonly openEject: (sessionID: string) => void;
}

export function buildClientMachine(deps: ClientMachineDeps) {
  return setup({
    types: machineTypes<{ context: ClientMachineContext; events: ClientMachineEvent }>(),
    actions: {
      openHome: () => {
        deps.openHome();
      },
      openAttached: (args) => {
        if (args.event.type === 'ATTACH') {
          deps.openAttached(args.event.sessionID);
        }
      },
      closeAttached: () => {
        deps.closeAttached();
      },
      openOverlay: () => {
        deps.openOverlay();
      },
      openHelp: () => {
        deps.openHelp();
      },
      setDestroyID: assign({
        destroyID: (args) => (args.event.type === 'CONFIRM_DESTROY' ? args.event.sessionID : null),
      }),
      resetDestroyID: assign({ destroyID: null }),
      setConsent: assign({
        consent: (args) => (args.event.type === 'CONSENT_ASKED' ? args.event.consent : null),
      }),
      resetConsent: assign({ consent: null }),
      setFreshUntil: assign({
        freshUntil: (args) =>
          args.event.type === 'RESTART_AWAITING_FRESH' ? args.event.freshUntil : 0,
      }),
      resetFreshUntil: assign({ freshUntil: 0 }),
    },
    guards: {
      isConnected: (args) => args.event.type === 'RESTART_ENDED' && args.event.connected,
    },
  }).createMachine({
    id: 'client',
    type: 'parallel',
    context: { destroyID: null, consent: null, freshUntil: 0 },
    states: {
      mode: {
        initial: 'home',
        states: {
          home: {
            entry: 'openHome',
            on: {
              ATTACH: 'attached',
              HOME: { target: 'home', reenter: true },
              OVERLAY: 'overlay',
              SPAWN: {
                target: 'picker',
                actions: (args) => {
                  deps.openPicker(args.event.resume);
                },
              },
            },
          },
          attached: {
            entry: 'openAttached',

            // The daemon sizes a session to the smallest client attached to
            // it, so a client that no longer shows the session lets it go.
            exit: 'closeAttached',
            on: {
              OVERLAY: 'overlay',
            },
          },
          overlay: {
            entry: 'openOverlay',
            on: {
              ATTACH: 'attached',
              HOME: 'home',
              OVERLAY: { target: 'overlay', reenter: true },
              HELP: 'help',
              SPAWN: {
                target: 'picker',
                actions: (args) => {
                  deps.openPicker(args.event.resume);
                },
              },
              EJECT: {
                target: 'picker-eject',
                actions: (args) => {
                  deps.openEject(args.event.sessionID);
                },
              },
            },
          },
          help: {
            entry: 'openHelp',
            on: {
              OVERLAY: 'overlay',
            },
          },
          picker: {
            on: {
              ATTACH: 'attached',
              HOME: 'home',
              OVERLAY: 'overlay',
            },
          },
          'picker-eject': {
            on: {
              ATTACH: 'attached',
              HOME: 'home',
              OVERLAY: 'overlay',
            },
          },
        },
      },
      confirm: {
        initial: 'none',
        on: {
          CONFIRM_KILL: { target: '.kill', actions: 'resetDestroyID' },
          CONFIRM_DESTROY: { target: '.destroy', actions: 'setDestroyID' },
          CONFIRM_DONE: { target: '.none', actions: 'resetDestroyID' },
          OVERLAY: { target: '.none', actions: 'resetDestroyID' },
        },
        states: {
          none: {},
          kill: {},
          destroy: {},
        },
      },
      consent: {
        initial: 'none',
        states: {
          none: { on: { CONSENT_ASKED: { target: 'asking', actions: 'setConsent' } } },
          asking: { on: { CONSENT_ANSWERED: { target: 'none', actions: 'resetConsent' } } },
        },
      },
      daemon: {
        initial: 'connected',
        states: {
          connected: {
            on: { DAEMON_LOST: 'waiting', RESTART_STARTED: 'restarting' },
          },
          waiting: {
            on: { DAEMON_READY: 'connected', RESTART_STARTED: 'restarting' },
          },
          restarting: {
            on: {
              RESTART_AWAITING_FRESH: { actions: 'setFreshUntil' },
              RESTART_ENDED: [
                { guard: 'isConnected', target: 'connected', actions: 'resetFreshUntil' },
                { target: 'waiting', actions: 'resetFreshUntil' },
              ],
            },
          },
        },
      },
    },
  });
}

// The running client machine that the TUI sends its events to.
export type ClientActor = Actor<ReturnType<typeof buildClientMachine>>;

// The screen the client shows, as the machine's mode region holds it.
export type ClientMode = ReturnType<ClientActor['getSnapshot']>['value']['mode'];
