import type { Clock } from '@atc/core';
import type { ScreenMenu } from '@atc/plugin-api';
import { planTypedLineInput } from '@atc/plugin-api';
import type { MenuView, SessionID } from '@atcx/contract';
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

  readonly menuTiming: MenuTiming;

  readonly startHeadlessTurn: (sessionID: SessionID, prompt: string) => boolean;
}

export interface SessionInput {
  readonly writeSessionInput: (
    sessionID: SessionID,
    data: string,
  ) => 'busy' | 'ok' | 'missing' | 'dead';

  readonly writeSessionLine: (
    sessionID: SessionID,
    text: string,
  ) => Promise<'busy' | 'ok' | 'missing' | 'dead' | 'permission_pending'>;

  readonly readSessionScreen: (id: SessionID) => Promise<ScreenText | 'missing' | 'no_screen'>;

  readonly readSessionMenu: (
    id: SessionID,
  ) => Promise<MenuView | null | 'missing' | 'no_screen' | 'unsupported'>;

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

  const getRuntime = (sessionID: SessionID): SessionRuntime => {
    const runtime = findRuntime(sessionID);

    if (runtime === undefined) {
      throw new Error(`session '${sessionID}' has no runtime`);
    }

    return runtime;
  };

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
