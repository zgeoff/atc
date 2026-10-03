import { homedir } from 'node:os';
import type { AgentID } from '../agents/agent-adapter';
import { DaemonError } from '../protocol/daemon-error';
import { loadConfig } from '../shared/config';
import { collectAgentPicks } from './collect-agent-picks';
import type { AgentPick } from './collect-agent-picks';
import { collectPathCompletions } from './collect-path-completions';
import { collectTargetPicks } from './collect-target-picks';
import type { TargetPick } from './collect-target-picks';
import { collectZoxideDirs } from './collect-zoxide-dirs';
import { collectDirs, formatDir, formatDirName, pickMatches } from './dirs';
import { planTextEdit } from './keys';
import { resolvePathInput } from './resolve-path-input';
import { ansi, cols, drawPicker } from './ui';

type PickerStep = 'agent' | 'dir' | 'target' | 'name' | 'prompt';

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
 * The modal flow behind n and r: agent, then directory, then execution
 * target when the daemon has more than one, then name, then an optional
 * first prompt. Every path out of it either attaches the new
 * session or returns the client to the screen it came from. A spawn the
 * daemon refuses is no path out: the flow stays open and shows why.
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

  // The configured roots, read with the agents each time the menu opens.
  private roots: readonly string[] = [];

  private dir = '';

  // The daemon's execution targets, read when the directory step opens,
  // and the one chosen; null spawns on the daemon's default target.
  private targets: TargetPick[] = [];

  private target: TargetPick | null = null;

  private name = '';

  private resume = false;

  private agent: AgentID = 'claude';

  // The daemon's refusal of the last spawn, shown in place of the hint until
  // the next key.
  private refusal: string | null = null;

  constructor(deps: SpawnPickerDeps<TMirror>) {
    this.deps = deps;
  }

  open(resume = false) {
    this.resume = resume;

    const config = loadConfig();

    this.picks = collectAgentPicks(config);
    this.roots = config.dirs.roots;
    this.input = '';

    // A last-used agent that is no longer installed is not in the menu, so
    // the selection falls to the first one that is.
    this.selected = Math.max(
      0,
      this.picks.findIndex((p) => p.agent === this.deps.getLastUsedAgent()),
    );

    this.agent = this.picks[this.selected]?.agent ?? this.deps.getLastUsedAgent();
    this.step = 'agent';
    this.refusal = null;

    process.stdout.write(ansi.clear);
    this.render();
  }

  applyKey(buf: Buffer) {
    this.refusal = null;

    const edit = planTextEdit(buf, this.input, {
      isLeaderKey: this.deps.isLeaderKey,
      moves: this.step === 'agent' || this.step === 'dir' || this.step === 'target',
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
      const items = this.collectDirItems().map((d) => formatDir(d));

      this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

      drawPicker({
        title: `${verb}: directory`,
        items,
        selected: this.selected,
        input: this.input,
        hint: 'type to filter, or a path (/ ~ .) · ↑↓ move · ⏎ select · esc cancel',
      });
    } else if (this.step === 'target') {
      this.selected = Math.min(this.selected, this.targets.length - 1);

      drawPicker({
        title: `${verb}: target`,
        items: this.targets.map((t) => formatTargetPick(t)),
        selected: this.selected,
        input: '',
        hint: this.refusal ?? `where ${formatDir(this.dir)} runs · ↑↓ move · ⏎ select · esc back`,
        dimmed: new Set(
          this.targets.flatMap((t, i) =>
            t.takesWorkspace || (t.available && t.inPlace) ? [] : [i],
          ),
        ),
      });
    } else if (this.step === 'name') {
      drawPicker({
        title: `${verb}: name`,
        items: [],
        selected: -1,
        input: this.input,
        placeholder: formatDirName(this.dir),
        hint: this.refusal ?? `session name for ${formatDir(this.dir)} · ⏎ accept · esc back`,
      });
    } else {
      drawPicker({
        title: 'spawn: initial prompt',
        items: [],
        selected: -1,
        input: this.input,
        placeholder: 'optional — ⏎ to start interactive',
        hint: this.refusal ?? 'first message for the session · ⏎ spawn · esc back',
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
    } else if (this.step === 'target') {
      this.step = 'dir';
    } else if (this.step === 'name') {
      this.openTargetOrDir('dir');
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
      const chosen =
        this.collectDirItems()[this.selected] ??
        resolvePathInput(this.input.trim(), process.cwd(), homedir());

      if (chosen === null) {
        return;
      }

      this.dir = chosen;
      this.input = '';

      this.openTargetOrDir('name');
    } else if (this.step === 'target') {
      const pick = this.targets[this.selected];

      if (pick === undefined) {
        return;
      }

      const refusal = findTargetRefusal(pick);

      if (refusal !== null) {
        this.refusal = refusal;

        this.render();

        return;
      }

      this.target = pick;
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

  /**
   * A typed path completes against the filesystem, like a shell; anything
   * else fuzzy-filters the merged list.
   */
  private collectDirItems(): string[] {
    return resolvePathInput(this.input, process.cwd(), homedir()) === null
      ? pickMatches(this.dirs, this.input)
      : collectPathCompletions(this.input, process.cwd(), homedir());
  }

  // Opens the target step when the daemon has more than one target, with
  // the chosen or default target selected, and the fallback step otherwise.
  private openTargetOrDir(fallback: 'dir' | 'name') {
    if (this.targets.length < 2) {
      this.target = null;
      this.step = fallback;

      return;
    }

    const preferred = this.target?.id;

    this.selected = Math.max(
      0,
      this.targets.findIndex((t) => (preferred === undefined ? t.isDefault : t.id === preferred)),
    );

    this.step = 'target';
  }

  private async openDirStep() {
    let recent: string[] = [];

    try {
      const listed = await this.deps.sendRequest('agents.list');

      this.targets = collectTargetPicks(listed);
    } catch {
      this.targets = [];
    }

    try {
      const answer = await this.deps.sendRequest('dirs.list');

      const dirs = answer['dirs'];

      if (Array.isArray(dirs)) {
        recent = dirs.filter((d): d is string => typeof d === 'string');
      }
    } catch {}

    this.dirs = collectDirs({
      cwd: process.cwd(),
      recent,
      roots: this.roots,
      zoxide: await collectZoxideDirs(),
    });

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
        ...this.buildTargetParams(),
      });

      const spawned = this.deps.toMirrorSession(ok['session']);

      if (spawned !== null) {
        this.deps.upsertMirror(spawned);

        await this.deps.attach(spawned.id);

        return;
      }
    } catch (error) {
      // A refused spawn keeps the picker on the step that sent it, with the
      // entered text back in the input, so the user can fix the cause and
      // retry or back out.
      const reason =
        error instanceof DaemonError ? `${error.code}: ${error.message}` : String(error);

      this.refusal = `${reason} · ⏎ retry · esc back`;
      this.input = this.resume ? this.name : prompt;

      process.stdout.write(ansi.clear);
      this.render();

      return;
    }

    this.deps.toBase();
  }

  // A chosen target goes with the spawn. A local directory runs in place on
  // a target on the daemon's own machine, and is materialized at the same
  // path from its pushed HEAD on any other.
  private buildTargetParams(): Readonly<Record<string, unknown>> {
    if (this.target === null) {
      return {};
    }

    return this.target.inPlace
      ? { target: this.target.id }
      : { target: this.target.id, workspace: { kind: 'path', path: this.dir } };
  }
}

function formatTargetPick(pick: TargetPick): string {
  const notes = [
    pick.provider,
    ...(pick.isDefault ? ['default'] : []),
    ...(pick.available ? [] : ['unavailable']),
    ...(pick.available && !pick.takesWorkspace ? ['no workspace'] : []),
  ];

  return `${pick.id}  ${notes.join(' · ')}`;
}

// Why a local directory cannot run on a target, or null when it can.
function findTargetRefusal(pick: TargetPick): string | null {
  if (!pick.available) {
    return `target '${pick.id}' is unavailable on this daemon · esc back`;
  }

  if (!pick.inPlace && !pick.takesWorkspace) {
    return `target '${pick.id}' cannot take a workspace · esc back`;
  }

  return null;
}
