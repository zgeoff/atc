import { setup } from 'xstate';

type ClientMachineEvent =
  | { readonly type: 'ATTACH'; readonly sessionID: string }
  | { readonly type: 'HOME' }
  | { readonly type: 'OVERLAY' }
  | { readonly type: 'HELP' }
  | { readonly type: 'SPAWN'; readonly resume: boolean }
  | { readonly type: 'EJECT'; readonly sessionID: string };

// What the machine borrows from the client that owns the screen, the fleet
// mirror, and the daemon connection. Every prop is a side effect the machine
// triggers but never performs itself.
export interface ClientMachineDeps {
  readonly openHome: () => void;
  readonly openAttached: (sessionID: string) => void;
  readonly openOverlay: () => void;
  readonly openHelp: () => void;
  readonly openPicker: (resume: boolean) => void;
  readonly openEject: (sessionID: string) => void;
}

/**
 * The client's mode as a statechart: which mode each event moves to, and
 * what runs on entry. `ATTACH` and `OVERLAY` reach several of the modes
 * below because several keys and outcomes lead to the same place —
 * attaching a session, or falling back to the overlay — and each landing
 * runs the same entry work regardless of where it was sent from.
 */
export function buildClientMachine(deps: ClientMachineDeps) {
  return setup({
    types: {
      // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the event union past the type layer
      events: {} as ClientMachineEvent,
    },
    actions: {
      openHome: () => {
        deps.openHome();
      },
      openAttached: (args) => {
        if (args.event.type === 'ATTACH') {
          deps.openAttached(args.event.sessionID);
        }
      },
      openOverlay: () => {
        deps.openOverlay();
      },
      openHelp: () => {
        deps.openHelp();
      },
    },
  }).createMachine({
    id: 'client',
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
  });
}
