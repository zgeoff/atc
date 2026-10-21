import type { Clock, SessionID } from '@atc/core';
import type { ScreenMenu } from '@atc/plugin-api';
import { planTypedLineInput } from '@atc/plugin-api';
import type { MenuView } from '@atc/protocol';
import { applyMenuChoice } from './apply-menu-choice';
import type { MenuChoice, MenuChoiceResult } from './apply-menu-choice';
import { buildMenuView } from './build-menu-view';
import type { ScreenText } from './create-screen-model';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';
import type { MenuTerminal, MenuTiming } from './menu-terminal';
import { readKnownMenu } from './read-known-menu';
import { readWholeMenu } from './read-whole-menu';
import { requireSessionPluginDirs } from './require-session-plugin-dirs';
import { writeLineSteps } from './write-line-steps';

interface SessionInputDeps {
  readonly manager: Pick<
    SessionManager,
    'sessions' | 'findAdapter' | 'findProvider' | 'requireExecution' | 'findExecutionRefusal'
  >;
  readonly clock: Clock;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  // How long a menu choice waits on a session's screen.
  readonly menuTiming: MenuTiming;

  // Starts a headless turn with the prompt given, and returns whether one
  // started.
  readonly startHeadlessTurn: (sessionID: SessionID, prompt: string) => boolean;
}

export interface SessionInput {
  // A headless turn runs only through the session's own target, never
  // anywhere else, and a dead session takes no input.
  readonly writeSessionInput: (
    sessionID: SessionID,
    data: string,
  ) => 'busy' | 'ok' | 'missing' | 'dead';

  // A headless turn takes the line as its prompt, and a missing or dead
  // session refuses a line as it refuses raw input.
  readonly writeSessionLine: (
    sessionID: SessionID,
    text: string,
  ) => Promise<'busy' | 'ok' | 'missing' | 'dead' | 'permission_pending'>;

  // A killed session keeps its last screen until a second kill removes it,
  // so a reader can still see what the agent printed before it died.
  readonly readSessionScreen: (id: SessionID) => Promise<ScreenText | 'missing' | 'no_screen'>;

  readonly readSessionMenu: (
    id: SessionID,
  ) => Promise<MenuView | null | 'missing' | 'no_screen' | 'unsupported'>;

  // The choice holds the session's input queue from its first read to its
  // last, so no other input lands between the keys it presses.
  readonly applySessionMenuChoice: (
    id: SessionID,
    choice: MenuChoice,
  ) => Promise<MenuChoiceResult | 'missing' | 'dead' | 'unsupported'>;
}

export function createSessionInput(deps: SessionInputDeps): SessionInput {
  const manager = deps.manager;
  const clock = deps.clock;
  const findRuntime = deps.findRuntime;
  const menuTiming = deps.menuTiming;
  const startHeadlessTurn = deps.startHeadlessTurn;

  // A session the manager holds has had its runtime since it was announced.
  const getRuntime = (sessionID: SessionID): SessionRuntime => {
    const runtime = findRuntime(sessionID);

    if (runtime === undefined) {
      throw new Error(`session '${sessionID}' has no runtime`);
    }

    return runtime;
  };

  // The session's terminal as a menu read or choice drives it. The PTY it
  // writes to is the one the session runs when the read or choice starts,
  // so a restarted session counts as gone.
  const buildMenuTerminal = (
    id: SessionID,
    findMenu: (text: string, rows?: number) => ScreenMenu | null,
  ): MenuTerminal => {
    const runtime = getRuntime(id);
    const pty = manager.sessions.find((x) => x.id === id)?.pty ?? null;

    return {
      readScreenMenu: async () => {
        if (runtime.screen === null) {
          return null;
        }

        const shown = await runtime.screen.captureText();

        return findMenu(shown.text, shown.rows);
      },
      readLastOutputAt: () => runtime.lastOutputAt,
      write: (data) => {
        pty?.write(data);
      },
      isLive: () => pty !== null && manager.sessions.find((x) => x.id === id)?.pty === pty,
      findWholeMenu: () => runtime.wholeMenu,
      recordWholeMenu: (menu) => {
        runtime.wholeMenu = menu;
      },
    };
  };

  const writeSessionInput = (
    sessionID: SessionID,
    data: string,
  ): 'busy' | 'ok' | 'missing' | 'dead' => {
    const session = manager.sessions.find((x) => x.id === sessionID);

    if (session === undefined) {
      return 'missing';
    }

    if (session.kind === 'headless') {
      manager.requireExecution(session, 'headless');

      if (session.state === 'exited') {
        return 'dead';
      }

      if ((findRuntime(sessionID)?.headlessRun ?? null) !== null) {
        return 'busy';
      }

      requireSessionPluginDirs(manager, session);

      return startHeadlessTurn(sessionID, data.trimEnd()) ? 'ok' : 'dead';
    }

    if (session.pty === null) {
      return 'dead';
    }

    manager.requireExecution(session, 'input');

    const pty = session.pty;
    const runtime = getRuntime(sessionID);

    // Input from outside a menu read or choice can open another list that
    // reads like the kept whole menu, so the kept menu is dropped.
    runtime.wholeMenu = null;

    // Input goes out at once unless a line is still being typed into the
    // session, and then waits behind it.
    runtime.input.schedule(() => {
      pty.write(data);
    });

    return 'ok';
  };

  return {
    writeSessionInput,

    writeSessionLine: (sessionID, text) => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      if (session === undefined || session.kind === 'headless' || session.pty === null) {
        return Promise.resolve(writeSessionInput(sessionID, text));
      }

      manager.requireExecution(session, 'input');

      // Typed text would confirm the prompt's highlighted option. Attaching
      // or a screen judgment changes the state while the prompt stays open,
      // so only the flag decides.
      if (session.permissionPending === true) {
        return Promise.resolve('permission_pending');
      }

      const runtime = getRuntime(sessionID);
      const bracketedPaste = runtime.screen?.hasBracketedPaste() ?? false;

      // A typed line can open another list that reads like the kept whole
      // menu, so the kept menu is dropped.
      runtime.wholeMenu = null;

      const adapter = manager.findAdapter(session.agent);
      const steps = adapter?.planLineInput?.(text, { bracketedPaste }) ?? planTypedLineInput(text);
      const pty = session.pty;

      const terminal = {
        write: (data: string) => {
          pty.write(data);
        },
        isLive: () => manager.sessions.find((x) => x.id === sessionID)?.pty === pty,
      };

      const typed = Promise.withResolvers<'ok' | 'dead'>();

      // the queue holds any other input until the last write, so none lands
      // between the text and its submit key; a terminal that ends or is
      // replaced mid-line gets none of the rest
      runtime.input.schedule(() => {
        const result = writeLineSteps(steps, terminal, (delayMs) => Bun.sleep(delayMs));

        typed.resolve(result);

        return result;
      });

      return typed.promise;
    },

    readSessionScreen: (id) => {
      if (!manager.sessions.some((x) => x.id === id)) {
        return Promise.resolve('missing');
      }

      const screen = findRuntime(id)?.screen ?? null;

      return screen === null ? Promise.resolve('no_screen') : screen.captureText();
    },

    readSessionMenu: async (id) => {
      const session = manager.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return 'missing';
      }

      const findMenu = manager.findAdapter(session.agent)?.findMenu;

      if (findMenu === undefined) {
        return 'unsupported';
      }

      const runtime = findRuntime(id);
      const screen = runtime?.screen ?? null;

      if (runtime === undefined || screen === null) {
        return 'no_screen';
      }

      const terminal = buildMenuTerminal(id, findMenu);

      const known = await readKnownMenu(terminal);

      // A list that scrolls past the screen is read with arrow keys, so the
      // read holds the session's input queue as a choice does. A target that
      // takes no input reads the list as its screen shows it.
      if (known?.scroll === undefined || manager.findExecutionRefusal(session, 'input') !== null) {
        return known === null ? null : buildMenuView(known);
      }

      const read = Promise.withResolvers<ScreenMenu | null>();

      runtime.input.schedule(async () => {
        await readWholeMenu(terminal, { clock, timing: menuTiming }).then(
          read.resolve,
          read.reject,
        );
      });

      const whole = await read.promise;

      return whole === null ? null : buildMenuView(whole);
    },

    applySessionMenuChoice: (id, choice) => {
      const session = manager.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return Promise.resolve('missing');
      }

      const findMenu = manager.findAdapter(session.agent)?.findMenu;

      if (findMenu === undefined) {
        return Promise.resolve('unsupported');
      }

      const runtime = getRuntime(id);
      const screen = runtime.screen;

      if (session.kind === 'headless' || session.pty === null || screen === null) {
        return Promise.resolve('dead');
      }

      manager.requireExecution(session, 'input');

      const terminal = buildMenuTerminal(id, findMenu);
      const applied = Promise.withResolvers<MenuChoiceResult>();

      runtime.input.schedule(async () => {
        await applyMenuChoice(terminal, choice, clock, menuTiming).then(
          applied.resolve,
          applied.reject,
        );
      });

      return applied.promise;
    },
  };
}
