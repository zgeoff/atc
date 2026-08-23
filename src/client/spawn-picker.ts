import type { AgentID } from '../agents/agent-adapter';
import { loadConfig } from '../shared/config';
import { collectAgentPicks } from './collect-agent-picks';
import type { AgentPick } from './collect-agent-picks';
import { collectDirs, formatDir, formatDirName, pickMatches } from './dirs';
import { planTextEdit } from './keys';
import { ansi, cols, drawPicker } from './ui';

type PickerStep = 'agent' | 'dir' | 'name' | 'prompt';

// What the flow borrows from the client that owns the screen, the daemon
// connection and the fleet mirror.
export interface SpawnPickerDeps<TMirror> {
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly ptyRows: () => number;
  readonly isLeaderKey: (buf: Buffer) => boolean;
  readonly getLastUsedAgent: () => AgentID;
  readonly scheduleStatus: () => void;
  readonly toBase: () => void;
  readonly attach: (sessionID: string) => Promise<void>;
  readonly toMirrorSession: (value: unknown) => TMirror | null;
  readonly upsertMirror: (session: Readonly<TMirror>) => void;
}

/**
 * The modal flow behind n and r: agent, then directory, then name, then an
 * optional first prompt. Every path out of it either attaches the new
 * session or returns the client to the screen it came from.
 */
export class SpawnPicker<TMirror extends { readonly id: string }> {
  private readonly deps: SpawnPickerDeps<TMirror>;

  private step: PickerStep = 'agent';

  private input = '';

  private selected = 0;

  // The installed agents, collected each time the menu opens so a config
  // edit or a fresh install lands without a client restart.
  private picks: AgentPick[] = [];

  private dirs: string[] = [];

  private dir = '';

  private name = '';

  private resume = false;

  private agent: AgentID = 'claude';

  constructor(deps: SpawnPickerDeps<TMirror>) {
    this.deps = deps;
  }

  open(resume = false) {
    this.resume = resume;
    this.picks = collectAgentPicks(loadConfig());
    this.input = '';

    // A last-used agent that is no longer installed is not in the menu, so
    // the selection falls to the first one that is.
    this.selected = Math.max(
      0,
      this.picks.findIndex((p) => p.agent === this.deps.getLastUsedAgent()),
    );

    this.agent = this.picks[this.selected]?.agent ?? this.deps.getLastUsedAgent();
    this.step = 'agent';

    process.stdout.write(ansi.clear);
    this.render();
  }

  applyKey(buf: Buffer) {
    const edit = planTextEdit(buf, this.input, {
      isLeaderKey: this.deps.isLeaderKey,
      moves: this.step === 'agent' || this.step === 'dir',
    });

    switch (edit.kind) {
      case 'none': {
        return;
      }
      case 'cancel': {
        this.applyCancel();

        return;
      }
      case 'leader': {
        this.deps.toBase();

        return;
      }
      case 'submit': {
        this.input = edit.value;

        this.applySubmit();

        return;
      }
      case 'move': {
        this.selected = edit.delta === 1 ? this.selected + 1 : Math.max(0, this.selected - 1);

        this.render();

        return;
      }
      case 'input': {
        this.input = edit.value;

        this.render();
      }
    }
  }

  render() {
    const verb = this.resume ? 'adopt' : 'spawn';

    if (this.step === 'agent') {
      this.selected = Math.min(this.selected, this.picks.length - 1);

      // An empty menu means every configured binary is missing, so the hint
      // carries the fix instead of the movement keys.
      const hint =
        this.picks.length === 0
          ? 'no agent CLI found — set claudeBin, grokBin, or codexBin in config.json · esc cancel'
          : '↑↓ move · ⏎ select · esc cancel';

      drawPicker({
        title: `${verb}: agent`,
        items: this.picks.map((p) => p.label),
        selected: this.selected,
        input: this.input,
        hint,
      });
    } else if (this.step === 'dir') {
      const items = pickMatches(this.dirs, this.input).map((d) => formatDir(d));

      this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

      drawPicker({
        title: `${verb}: directory`,
        items,
        selected: this.selected,
        input: this.input,
        hint: 'type to filter · ↑↓ move · ⏎ select · esc cancel',
      });
    } else if (this.step === 'name') {
      drawPicker({
        title: `${verb}: name`,
        items: [],
        selected: -1,
        input: this.input,
        placeholder: formatDirName(this.dir),
        hint: `session name for ${formatDir(this.dir)} · ⏎ accept · esc back`,
      });
    } else {
      drawPicker({
        title: 'spawn: initial prompt',
        items: [],
        selected: -1,
        input: this.input,
        placeholder: 'optional — ⏎ to start interactive',
        hint: 'first message for the session · ⏎ spawn · esc back',
      });
    }

    this.deps.scheduleStatus();
  }

  private applyCancel() {
    if (this.step === 'agent') {
      this.deps.toBase();

      return;
    }

    this.input = '';

    if (this.step === 'dir') {
      this.selected = Math.max(
        0,
        this.picks.findIndex((p) => p.agent === this.agent),
      );

      this.step = 'agent';
    } else if (this.step === 'name') {
      this.step = 'dir';
    } else {
      this.step = 'name';
    }

    process.stdout.write(ansi.clear);
    this.render();
  }

  private applySubmit() {
    if (this.step === 'agent') {
      const pick = this.picks[this.selected];

      // With no agent installed the menu is empty and there is nothing to
      // spawn.
      if (pick === undefined) {
        return;
      }

      this.agent = pick.agent;
      void this.openDirStep();

      return;
    }

    if (this.step === 'dir') {
      const items = pickMatches(this.dirs, this.input);
      const raw = this.input.trim();
      let chosen = items[this.selected] ?? null;

      if (chosen === null && (raw.startsWith('/') || raw.startsWith('~'))) {
        chosen = raw.replace(/^~/u, process.env['HOME'] ?? '~');
      }

      if (chosen === null) {
        return;
      }

      this.dir = chosen;
      this.input = '';
      this.step = 'name';
    } else if (this.step === 'name') {
      this.name = this.input.trim();
      this.input = '';

      // Adopt skips the prompt step: the agent's own resume picker opens
      // inside the new PTY.
      if (this.resume) {
        void this.spawn('');

        return;
      }

      this.step = 'prompt';
    } else {
      void this.spawn(this.input.trim());

      return;
    }

    process.stdout.write(ansi.clear);
    this.render();
  }

  private async openDirStep() {
    let recent: string[] = [];

    try {
      const answer = await this.deps.sendRequest('dirs.list');

      const dirs = answer['dirs'];

      if (Array.isArray(dirs)) {
        recent = dirs.filter((d): d is string => typeof d === 'string');
      }
    } catch {}

    this.dirs = await collectDirs(recent);

    this.input = '';
    this.selected = 0;
    this.step = 'dir';

    process.stdout.write(ansi.clear);
    this.render();
  }

  private async spawn(prompt: string) {
    try {
      const ok = await this.deps.sendRequest('session.spawn', {
        cwd: this.dir,
        name: this.name,
        prompt,
        cols: cols(),
        rows: this.deps.ptyRows(),
        ...(this.resume ? { resume: true } : {}),
        agent: this.agent,
      });

      const spawned = this.deps.toMirrorSession(ok['session']);

      if (spawned !== null) {
        this.deps.upsertMirror(spawned);

        await this.deps.attach(spawned.id);

        return;
      }
    } catch {}

    this.deps.toBase();
  }
}
