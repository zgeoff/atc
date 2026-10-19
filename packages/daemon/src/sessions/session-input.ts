import type { Clock, SessionID } from '@atc/core';
import type { ScreenMenu } from '@atc/plugin-api';
import { planTypedLineInput } from '@atc/plugin-api';
import type { MenuView } from '@atc/protocol';
import { applyMenuChoice } from './apply-menu-choice';
import type { MenuChoice, MenuChoiceResult } from './apply-menu-choice';
import { buildMenuView } from './build-menu-view';
import type { MenuTerminal, MenuTiming } from './menu-terminal';
import { readKnownMenu } from './read-known-menu';
import { readWholeMenu } from './read-whole-menu';
import { requireSessionPluginDirs } from './require-session-plugin-dirs';
import type { ScreenText } from './screen-model';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';
import { writeLineSteps } from './write-line-steps';

interface SessionInputDeps {
  readonly mgr: Pick<
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

export class SessionInput {
  private readonly mgr: SessionInputDeps['mgr'];

  private readonly clock: Clock;

  private readonly findRuntime: SessionInputDeps['findRuntime'];

  private readonly menuTiming: MenuTiming;

  private readonly startHeadlessTurn: SessionInputDeps['startHeadlessTurn'];

  constructor(deps: SessionInputDeps) {
    this.mgr = deps.mgr;
    this.clock = deps.clock;
    this.findRuntime = deps.findRuntime;
    this.menuTiming = deps.menuTiming;
    this.startHeadlessTurn = deps.startHeadlessTurn;
  }

  // A headless turn runs only through the session's own target, never
  // anywhere else, and a dead session takes no input.
  writeSessionInput(sessionID: SessionID, data: string): 'busy' | 'ok' | 'missing' | 'dead' {
    const s = this.mgr.sessions.find((x) => x.id === sessionID);

    if (s === undefined) {
      return 'missing';
    }

    if (s.kind === 'headless') {
      this.mgr.requireExecution(s, 'headless');

      if (s.state === 'exited') {
        return 'dead';
      }

      if ((this.findRuntime(sessionID)?.headlessRun ?? null) !== null) {
        return 'busy';
      }

      requireSessionPluginDirs(this.mgr, s);

      return this.startHeadlessTurn(sessionID, data.trimEnd()) ? 'ok' : 'dead';
    }

    if (s.pty === null) {
      return 'dead';
    }

    this.mgr.requireExecution(s, 'input');

    const pty = s.pty;
    const runtime = this.getRuntime(sessionID);

    // Input from outside a menu read or choice can open another list that
    // reads like the kept whole menu, so the kept menu is dropped.
    runtime.wholeMenu = null;

    // Input goes out at once unless a line is still being typed into the
    // session, and then waits behind it.
    runtime.input.schedule(() => {
      pty.write(data);
    });

    return 'ok';
  }

  // A headless turn takes the line as its prompt, and a missing or dead
  // session refuses a line as it refuses raw input.
  writeSessionLine(
    sessionID: SessionID,
    text: string,
  ): Promise<'busy' | 'ok' | 'missing' | 'dead' | 'permission_pending'> {
    const s = this.mgr.sessions.find((x) => x.id === sessionID);

    if (s === undefined || s.kind === 'headless' || s.pty === null) {
      return Promise.resolve(this.writeSessionInput(sessionID, text));
    }

    this.mgr.requireExecution(s, 'input');

    // Typed text would confirm the prompt's highlighted option. Attaching
    // or a screen judgment changes the state while the prompt stays open,
    // so only the flag decides.
    if (s.permissionPending === true) {
      return Promise.resolve('permission_pending');
    }

    const runtime = this.getRuntime(sessionID);
    const bracketedPaste = runtime.screen?.hasBracketedPaste() ?? false;

    // A typed line can open another list that reads like the kept whole
    // menu, so the kept menu is dropped.
    runtime.wholeMenu = null;

    const adapter = this.mgr.findAdapter(s.agent);
    const steps = adapter?.planLineInput?.(text, { bracketedPaste }) ?? planTypedLineInput(text);
    const pty = s.pty;

    const terminal = {
      write: (data: string) => {
        pty.write(data);
      },
      isLive: () => this.mgr.sessions.find((x) => x.id === sessionID)?.pty === pty,
    };

    const typed = Promise.withResolvers<'ok' | 'dead'>();

    // the queue holds any other input until the last write, so none lands
    // between the text and its submit key; a terminal that ends or is
    // replaced mid-line gets none of the rest
    runtime.input.schedule(() => {
      const result = writeLineSteps(steps, terminal, (ms) => Bun.sleep(ms));

      typed.resolve(result);

      return result;
    });

    return typed.promise;
  }

  // A killed session keeps its last screen until a second kill removes it,
  // so a reader can still see what the agent printed before it died.
  readSessionScreen(id: SessionID): Promise<ScreenText | 'missing' | 'no_screen'> {
    if (!this.mgr.sessions.some((x) => x.id === id)) {
      return Promise.resolve('missing');
    }

    const screen = this.findRuntime(id)?.screen ?? null;

    return screen === null ? Promise.resolve('no_screen') : screen.renderText();
  }

  async readSessionMenu(
    id: SessionID,
  ): Promise<MenuView | null | 'missing' | 'no_screen' | 'unsupported'> {
    const s = this.mgr.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return 'missing';
    }

    const findMenu = this.mgr.findAdapter(s.agent)?.findMenu;

    if (findMenu === undefined) {
      return 'unsupported';
    }

    const runtime = this.findRuntime(id);
    const screen = runtime?.screen ?? null;

    if (runtime === undefined || screen === null) {
      return 'no_screen';
    }

    const terminal = this.buildMenuTerminal(id, findMenu);

    const known = await readKnownMenu(terminal);

    // A list that scrolls past the screen is read with arrow keys, so the
    // read holds the session's input queue as a choice does. A target that
    // takes no input reads the list as its screen shows it.
    if (known?.scroll === undefined || this.mgr.findExecutionRefusal(s, 'input') !== null) {
      return known === null ? null : buildMenuView(known);
    }

    const read = Promise.withResolvers<ScreenMenu | null>();

    runtime.input.schedule(async () => {
      await readWholeMenu(terminal, { clock: this.clock, timing: this.menuTiming }).then(
        read.resolve,
        read.reject,
      );
    });

    const whole = await read.promise;

    return whole === null ? null : buildMenuView(whole);
  }

  // The choice holds the session's input queue from its first read to its
  // last, so no other input lands between the keys it presses.
  applySessionMenuChoice(
    id: SessionID,
    choice: MenuChoice,
  ): Promise<MenuChoiceResult | 'missing' | 'dead' | 'unsupported'> {
    const s = this.mgr.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return Promise.resolve('missing');
    }

    const findMenu = this.mgr.findAdapter(s.agent)?.findMenu;

    if (findMenu === undefined) {
      return Promise.resolve('unsupported');
    }

    const runtime = this.getRuntime(id);
    const screen = runtime.screen;

    if (s.kind === 'headless' || s.pty === null || screen === null) {
      return Promise.resolve('dead');
    }

    this.mgr.requireExecution(s, 'input');

    const terminal = this.buildMenuTerminal(id, findMenu);
    const applied = Promise.withResolvers<MenuChoiceResult>();

    runtime.input.schedule(async () => {
      await applyMenuChoice(terminal, choice, this.clock, this.menuTiming).then(
        applied.resolve,
        applied.reject,
      );
    });

    return applied.promise;
  }

  // A session the manager holds has had its runtime since it was announced.
  private getRuntime(sessionID: SessionID): SessionRuntime {
    const runtime = this.findRuntime(sessionID);

    if (runtime === undefined) {
      throw new Error(`session '${sessionID}' has no runtime`);
    }

    return runtime;
  }

  // The session's terminal as a menu read or choice drives it. The PTY it
  // writes to is the one the session runs when the read or choice starts,
  // so a restarted session counts as gone.
  private buildMenuTerminal(
    id: SessionID,
    findMenu: (text: string, rows?: number) => ScreenMenu | null,
  ): MenuTerminal {
    const runtime = this.getRuntime(id);
    const pty = this.mgr.sessions.find((x) => x.id === id)?.pty ?? null;

    return {
      readScreenMenu: async () => {
        if (runtime.screen === null) {
          return null;
        }

        const shown = await runtime.screen.renderText();

        return findMenu(shown.text, shown.rows);
      },
      readLastOutputAt: () => runtime.lastOutputAt,
      write: (data) => {
        pty?.write(data);
      },
      isLive: () => pty !== null && this.mgr.sessions.find((x) => x.id === id)?.pty === pty,
      findWholeMenu: () => runtime.wholeMenu,
      recordWholeMenu: (menu) => {
        runtime.wholeMenu = menu;
      },
    };
  }
}
