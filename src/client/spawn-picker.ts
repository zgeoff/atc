import { homedir } from 'node:os';
import { DaemonError } from '../protocol/daemon-error';
import type { AgentID } from '../shared/agent-id';
import type { WorkspacesConfig } from '../shared/collect-workspaces-config';
import { collectZoxideDirs } from '../shared/collect-zoxide-dirs';
import { loadConfig } from '../shared/config';
import { DEFAULT_GIT_TRANSPORTS } from '../shared/default-git-transports';
import { isGitURL } from '../shared/is-git-url';
import { isRecord } from '../shared/report';
import { resolveHomeDir } from '../shared/resolve-home-dir';
import { buildWorkspaceDestination } from './build-workspace-destination';
import { collectAgentPicks } from './collect-agent-picks';
import type { AgentPick } from './collect-agent-picks';
import { collectPathCompletions } from './collect-path-completions';
import { collectTargetPicks } from './collect-target-picks';
import type { TargetPick } from './collect-target-picks';
import { collectDirs, formatDir, formatDirName, pickMatches } from './dirs';
import { KEY, planTextEdit } from './keys';
import { pickRefusalStep } from './pick-refusal-step';
import { resolvePathInput } from './resolve-path-input';
import { resolveWorkspaceRoot } from './resolve-workspace-root';
import { ansi, cols, drawPicker } from './ui';

type PickerStep = 'agent' | 'dir' | 'source' | 'ref' | 'target' | 'confirm' | 'name' | 'prompt';

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

// One source `agents.list` returned, in the order the daemon offers them.
interface AnnouncedSource {
  readonly id: string;
  readonly label: string;
  readonly kind: 'git' | 'path';
}

// What a candidate or a reading of typed input resolves to.
type SourcePick =
  | { readonly kind: 'path'; readonly dir: string }
  | { readonly kind: 'git'; readonly url: string };

// One candidate `sources.list` returned.
interface ListedCandidate {
  readonly label: string;
  readonly detail: string | null;
  readonly pick: SourcePick;
}

// What `sources.interpret` read typed input as.
type Interpretation =
  | { readonly kind: 'browse'; readonly scope: string }
  | SourcePick
  | { readonly kind: 'none' };

// One branch or tag `git.probe` returned.
interface ProbedRef {
  readonly name: string;
  readonly kind: 'branch' | 'tag';
  readonly sha: string;
}

// The repository the probe proved the daemon's host can read.
interface ProbedRepo {
  // What the user chose, shown as the source step's input on the way back
  // to it.
  readonly label: string;

  // The URL the clone fetches, as the daemon resolved it.
  readonly url: string;
  readonly head: string | null;
  readonly refs: readonly ProbedRef[];
}

// The commit the spawn checks out, and the branch or tag it came from.
interface ChosenRef {
  readonly ref: string | null;
  readonly sha: string;
}

const FULL_SHA_PATTERN = /^(?:[\da-f]{40}|[\da-f]{64})$/u;
const SHORT_SHA_PATTERN = /^[\da-f]{7,63}$/u;

// A request the step waits on, and the number that tells its answer from a
// cancelled one's.
interface PendingRequest {
  readonly label: string;
  readonly seq: number;
  readonly kind: 'interpret' | 'probe' | 'spawn';
}

// What a git source step does once it opens: nothing, probe a URL a
// reading of typed input already resolved, or list the scope a reading
// asked for, once the step's target is known.
type SourceStepAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'probe'; readonly url: string }
  | { readonly kind: 'browse'; readonly scope: string };

/**
 * The modal flow behind n and r: agent, then source, then name, then an
 * optional first prompt. The sources are the ones the daemon offers, in
 * its order, and Tab cycles them; a daemon that offers none gets the local
 * directory flow alone. A source of directories is followed by the
 * execution target when the daemon has more than one. A source of git
 * repositories opens the target first, then its candidates, the ref, and a
 * confirm screen with the destination the checkout lands in, so every
 * request about the repository is made for the target the spawn runs on.
 * Typed input a source does not match against its candidates is read by
 * the source, then by the others in order. Every path out of the flow
 * either attaches the new session or returns the client to the screen it
 * came from. A spawn the daemon refuses is no path out: the flow returns to
 * the step that can fix the cause and shows why. Esc cancels a request in
 * flight and drops its late answer.
 */
export class SpawnPicker<TMirror extends { readonly id: string }> {
  private readonly deps: SpawnPickerDeps<TMirror>;

  private step: PickerStep = 'agent';

  // The sources the daemon offers, or null when it offers none, and the
  // one the flow is on; -1 is the local directory flow of a daemon that
  // offers none.
  private sources: readonly AnnouncedSource[] | null = null;

  private sourceIndex = -1;

  private input = '';

  private selected = 0;

  // The installed agents, collected each time the menu opens so a config
  // edit or a fresh install lands without a client restart.
  private picks: AgentPick[] = [];

  // The directories the directory step lists, and the label each shows.
  private dirs: string[] = [];

  private dirLabels: ReadonlyMap<string, string> = new Map();

  // The configured roots and workspace settings, read with the agents each
  // time the menu opens.
  private roots: readonly string[] = [];

  private workspaces: WorkspacesConfig = {
    githubOwner: null,
    sources: null,
    gitTransports: DEFAULT_GIT_TRANSPORTS,
    root: null,
    targetRoots: new Map(),
  };

  private dir = '';

  // The daemon's execution targets, read when the agent is chosen, and the
  // one chosen; null spawns on the daemon's default target.
  private targets: TargetPick[] = [];

  private target: TargetPick | null = null;

  // The git source's candidates and the scope they were listed under, or
  // the notice that stands in for a list the daemon could not give, with
  // the source and target they were listed for. A listing runs behind the
  // step, so typing goes on.
  private candidates: ListedCandidate[] = [];

  private listedScope: string | null = null;

  private listNotice: string | null = null;

  private listedKey: string | null = null;

  private listingSeq: number | null = null;

  // The directory listing the flow waits on before it opens the directory
  // step, or null when it waits on none.
  private pathListingSeq: number | null = null;

  // The source step's text while the flow is on another step, and what the
  // step does as soon as it opens.
  private sourceDraft = '';

  private sourceAction: SourceStepAction = { kind: 'none' };

  // The other URL form of a repository whose probe failed, offered as the
  // source step's one item until the input changes.
  private alternateURL: string | null = null;

  private repo: ProbedRepo | null = null;

  private ref: ChosenRef | null = null;

  // The destination on the confirm screen, before any suffix a refused
  // spawn adds, that suffix's number, and whether the user typed the
  // destination rather than taking the default.
  private destination = '';

  private destinationAttempt = 1;

  private destinationEdited = false;

  // The repository the destination was built or typed for.
  private destinationRepoURL: string | null = null;

  private name = '';

  private resume = false;

  private agent: AgentID = 'claude';

  // Why the last action was refused, shown in place of the hint until the
  // next key.
  private refusal: string | null = null;

  private pending: PendingRequest | null = null;

  private requestSeq = 0;

  // The flow's generation. Opening the flow and every way out of it moves
  // it on, and an answer that arrives for an earlier generation is dropped
  // before it changes any state or draws anything.
  private generation = 0;

  constructor(deps: SpawnPickerDeps<TMirror>) {
    this.deps = deps;
  }

  open(resume = false) {
    this.generation += 1;
    this.resume = resume;

    const config = loadConfig();

    this.picks = collectAgentPicks(config);
    this.roots = config.dirs.roots;
    this.workspaces = config.workspaces;
    this.input = '';
    this.sources = null;
    this.sourceIndex = -1;
    this.target = null;
    this.repo = null;
    this.ref = null;
    this.sourceDraft = '';
    this.sourceAction = { kind: 'none' };
    this.listedKey = null;
    this.listingSeq = null;
    this.pathListingSeq = null;
    this.alternateURL = null;
    this.destination = '';
    this.destinationEdited = false;
    this.destinationRepoURL = null;

    // A last-used agent that is no longer installed is not in the menu, so
    // the selection falls to the first one that is.
    this.selected = Math.max(
      0,
      this.picks.findIndex((p) => p.agent === this.deps.getLastUsedAgent()),
    );

    this.agent = this.picks[this.selected]?.agent ?? this.deps.getLastUsedAgent();
    this.step = 'agent';
    this.refusal = null;
    this.pending = null;

    process.stdout.write(ansi.clear);
    this.render();
  }

  applyKey(buf: Buffer) {
    this.refusal = null;

    const edit = planTextEdit(buf, this.input, {
      isLeaderKey: this.deps.isLeaderKey,
      moves:
        this.step === 'agent' ||
        this.step === 'dir' ||
        this.step === 'source' ||
        this.step === 'ref' ||
        this.step === 'target',
    });

    // A request in flight owns the step: Esc cancels it, the leader leaves,
    // and every other key waits for the answer.
    if (this.pending !== null) {
      if (edit.kind === 'cancel') {
        this.applyPendingCancel();
      } else if (edit.kind === 'leader') {
        this.quitFlow();
      }

      return;
    }

    const tab = buf.length === 1 && buf[0] === KEY.tab;

    // A tab to a source of directories waits for its listing on the step it
    // left. Any other key there acts on that step, so the flow stays on it
    // and the listing no longer opens its step.
    if (!tab && (this.step === 'dir' || this.step === 'source')) {
      this.pathListingSeq = null;
    }

    // Tab moves a spawn to the next source the daemon offers. Adopt resumes
    // a session in a directory that already holds one, so it stays on its
    // directories.
    if (tab) {
      if (!this.resume && (this.step === 'dir' || this.step === 'source')) {
        this.openNextSource();
      }

      return;
    }

    switch (edit.kind) {
      case 'none': {
        return;
      }
      case 'cancel': {
        this.applyCancel();

        return;
      }
      case 'leader': {
        this.quitFlow();

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
        this.applyInput(edit.value);
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
      this.renderDirStep(verb);
    } else if (this.step === 'source') {
      this.renderSourceStep();
    } else if (this.step === 'ref') {
      this.renderRefStep();
    } else if (this.step === 'target') {
      this.renderTargetStep(verb);
    } else if (this.step === 'confirm') {
      this.renderConfirmStep();
    } else if (this.step === 'name') {
      const where = this.isGitFlow() ? this.formatDestination() : formatDir(this.dir);

      drawPicker({
        title: `${verb}: name`,
        items: [],
        selected: -1,
        input: this.input,
        placeholder: formatDirName(this.dir),
        hint: this.refusal ?? `session name for ${where} · ⏎ accept · esc back`,
      });
    } else {
      drawPicker({
        title: 'spawn: initial prompt',
        items: [],
        selected: -1,
        input: this.input,
        placeholder: 'optional — ⏎ to start interactive',
        hint:
          this.pending?.label ??
          this.refusal ??
          'first message for the session · ⏎ spawn · esc back',
      });
    }

    this.deps.scheduleStatus();
  }

  // Leaves the flow for the screen it came from, dropping every answer
  // still on its way.
  private quitFlow() {
    this.stopFlow();
    this.deps.toBase();
  }

  // Ends the flow's generation: no request it sent changes anything when
  // its answer comes.
  private stopFlow() {
    this.generation += 1;
    this.pending = null;
    this.listingSeq = null;
    this.pathListingSeq = null;
  }

  // Whether an answer belongs to a flow that has since ended.
  private isStale(generation: number): boolean {
    return generation !== this.generation;
  }

  private renderDirStep(verb: string) {
    const items = this.collectDirItems().map((d) => this.dirLabels.get(d) ?? formatDir(d));

    this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

    drawPicker({
      title: `${verb}: ${this.findSource()?.label ?? 'directory'}`,
      items,
      selected: this.selected,
      input: this.input,
      hint:
        this.pending?.label ??
        this.refusal ??
        `type to filter, or a path (/ ~ .) · ↑↓ move · ⏎ select${this.formatTabHint()} · esc cancel`,
    });
  }

  private renderTargetStep(verb: string) {
    this.selected = Math.min(this.selected, this.targets.length - 1);

    const git = this.isGitFlow();
    const what = git ? 'the repository' : formatDir(this.dir);

    drawPicker({
      title: `${verb}: target`,
      items: this.targets.map((t) => formatTargetPick(t)),
      selected: this.selected,
      input: '',
      hint: this.refusal ?? `where ${what} runs · ↑↓ move · ⏎ select · esc back`,
      dimmed: new Set(
        this.targets.flatMap((t, i) =>
          t.takesWorkspace || (!git && t.available && t.inPlace) ? [] : [i],
        ),
      ),
    });
  }

  private renderSourceStep() {
    const items = this.collectCandidateItems();

    this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

    const scope = this.listedScope === null ? '' : ` · ${this.listedScope}`;
    const listing = this.listingSeq === null ? null : 'listing… · esc stops';

    drawPicker({
      title: `spawn: ${this.findSource()?.label ?? ''}${scope}`,
      items: items.map((item) => item.label),
      selected: items.length === 0 || items[0]?.notice === true ? -1 : this.selected,
      input: this.input,
      hint:
        this.pending?.label ??
        this.refusal ??
        listing ??
        `type to filter, or a git URL · ↑↓ move · ⏎ select${this.formatTabHint()} · esc back`,
      dimmed: new Set(items.flatMap((item, i) => (item.notice === true ? [i] : []))),
    });
  }

  private renderRefStep() {
    const items = this.collectRefItems();

    this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

    drawPicker({
      title: `spawn: ref · ${this.repo?.label ?? ''}`,
      items: items.map((item) => formatRef(item, this.repo?.head ?? null)),
      selected: items.length === 0 ? -1 : this.selected,
      input: this.input,
      hint:
        this.pending?.label ??
        this.refusal ??
        'branch, tag, or full commit id · ↑↓ move · ⏎ select · esc back',
    });
  }

  private renderConfirmStep() {
    const ref = this.ref;
    const target = this.findEffectiveTarget();
    let refRow = '';

    if (ref !== null) {
      refRow = ref.ref === null ? `commit ${ref.sha}` : `${ref.ref} → ${ref.sha.slice(0, 12)}`;
    }

    drawPicker({
      title: 'spawn: confirm',
      items: [
        `source  ${this.repo?.url ?? ''}`,
        `ref     ${refRow}`,
        `target  ${target === null ? 'default' : `${target.id} (${target.provider})`}`,
        `dest    ${this.formatDestination()}`,
        `agent   ${this.agent}`,
      ],
      selected: -1,
      input: this.input,
      placeholder: 'destination on the target',
      hint: this.refusal ?? 'destination on the target · ⏎ continue · esc back',
    });
  }

  // The source the flow is on, or null on the local directory flow.
  private findSource(): AnnouncedSource | null {
    return this.sources?.[this.sourceIndex] ?? null;
  }

  // Whether the flow is choosing a git repository rather than a directory.
  private isGitFlow(): boolean {
    return this.findSource()?.kind === 'git';
  }

  // The hint that Tab moves to the next source, when there is one to move
  // to.
  private formatTabHint(): string {
    const sources = this.sources ?? [];

    if (this.resume || sources.length < 2) {
      return '';
    }

    const next = sources[(this.sourceIndex + 1) % sources.length];

    return next === undefined ? '' : ` · tab ${next.label}`;
  }

  private applyInput(value: string) {
    // The target step takes no text: its list is short and fixed.
    if (this.step === 'target') {
      return;
    }

    this.input = value;

    if (this.step === 'source') {
      this.alternateURL = null;
    }

    // A pasted URL in the directory step is a repository, not a path, so
    // the flow moves to the first source of repositories with it.
    if (this.step === 'dir' && !this.resume && isGitURL(value) && !value.startsWith('/')) {
      const index = this.sources?.findIndex((source) => source.kind === 'git') ?? -1;

      if (index !== -1) {
        this.openGitSource(index, value, { kind: 'none' });

        return;
      }
    }

    this.render();
  }

  // Stops waiting on the request in flight. Its answer, when it comes, is
  // dropped. A spawn goes on on the daemon, which lists the session once
  // it starts, so the flow leaves rather than offer to spawn it again.
  private applyPendingCancel() {
    const cancelled = this.pending;

    this.pending = null;

    if (cancelled?.kind === 'spawn') {
      this.quitFlow();

      return;
    }

    this.refusal = 'cancelled · esc back';

    process.stdout.write(ansi.clear);
    this.render();
  }

  private applyCancel() {
    // Esc leaves whatever step the flow is on, so a directory listing it
    // was waiting on no longer opens its step.
    this.pathListingSeq = null;

    if (this.step === 'agent') {
      this.quitFlow();

      return;
    }

    // Esc first stops a listing in flight, keeping the step.
    if (this.step === 'source' && this.listingSeq !== null) {
      this.listingSeq = null;
      this.listedKey = null;
      this.listNotice = 'listing stopped — type to enter one';

      this.render();

      return;
    }

    const typed = this.input;

    this.input = '';

    if (this.step === 'dir') {
      this.openAgentStep();
    } else if (this.step === 'source') {
      this.sourceDraft = typed;

      this.applySourceCancel();
    } else if (this.step === 'ref') {
      this.input = this.repo?.label ?? '';
      this.repo = null;
      this.step = 'source';
    } else if (this.step === 'target') {
      this.applyTargetCancel();

      return;
    } else if (this.step === 'confirm') {
      this.openRefStep();
    } else if (this.step === 'name') {
      if (this.isGitFlow()) {
        this.input = this.buildDestination();
        this.step = 'confirm';
      } else {
        this.openTargetStep(() => {
          this.step = 'dir';
        });
      }
    } else {
      this.input = this.name;
      this.step = 'name';
    }

    process.stdout.write(ansi.clear);
    this.render();
  }

  private openAgentStep() {
    this.selected = Math.max(
      0,
      this.picks.findIndex((p) => p.agent === this.agent),
    );

    this.step = 'agent';
  }

  // Leaves a git source step backwards: to the target step when the daemon
  // has more than one target, else to the agent.
  private applySourceCancel() {
    if (this.targets.length >= 2) {
      this.openTargetStep(() => {});

      return;
    }

    this.openAgentStep();
  }

  // Leaves the target step backwards: a directory goes back to its step,
  // and a repository to the first source of directories, else the agent.
  private applyTargetCancel() {
    this.sourceAction = { kind: 'none' };

    if (!this.isGitFlow()) {
      this.step = 'dir';

      process.stdout.write(ansi.clear);
      this.render();

      return;
    }

    const index = this.sources?.findIndex((source) => source.kind === 'path') ?? -1;

    if (index === -1) {
      this.openAgentStep();
      process.stdout.write(ansi.clear);
      this.render();

      return;
    }

    void this.openPathSource(index, null);
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
      void this.openFirstSource();

      return;
    }

    if (this.step === 'source') {
      void this.applySourceSubmit();

      return;
    }

    if (this.step === 'ref') {
      void this.applyRefSubmit();

      return;
    }

    if (this.step === 'dir') {
      void this.applyDirSubmit();

      return;
    }

    if (this.step === 'target') {
      this.applyTargetSubmit();

      return;
    }

    if (this.step === 'confirm') {
      if (!this.applyDestination(this.input.trim())) {
        this.render();

        return;
      }

      this.input = this.name;
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

  // Takes the directory step's choice: a listed or completed directory, a
  // typed path, or else what the sources read the text as.
  private async applyDirSubmit() {
    const typed = this.input.trim();

    const chosen =
      this.collectDirItems()[this.selected] ?? resolvePathInput(typed, process.cwd(), homedir());

    if (chosen !== null) {
      this.applyDir(chosen);

      return;
    }

    if (typed !== '' && this.sources !== null) {
      await this.readTypedInput(typed, true);
    }
  }

  private applyDir(dir: string) {
    this.dir = dir;
    this.input = '';

    this.openTargetStep(() => {
      this.step = 'name';
    });

    process.stdout.write(ansi.clear);
    this.render();
  }

  private applyTargetSubmit() {
    const pick = this.targets[this.selected];

    if (pick === undefined) {
      return;
    }

    const refusal = findTargetRefusal(pick, this.isGitFlow());

    if (refusal !== null) {
      this.refusal = refusal;

      this.render();

      return;
    }

    // A default destination belongs to the target it was built for.
    if (pick.id !== this.target?.id && !this.destinationEdited) {
      this.destination = '';
    }

    this.target = pick;
    this.input = '';

    if (this.isGitFlow()) {
      this.openSourceStep();

      return;
    }

    this.step = 'name';

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

  // The git source step's rows: the other URL form after a failed probe,
  // the notice in place of a list the daemon could not give, or the listed
  // candidates the input matches.
  private collectCandidateItems(): {
    label: string;
    notice?: boolean;
    candidate?: ListedCandidate;
    url?: string;
  }[] {
    if (this.alternateURL !== null) {
      return [{ label: `try ${this.alternateURL} instead`, url: this.alternateURL }];
    }

    if (this.listNotice !== null) {
      return [{ label: this.listNotice, notice: true }];
    }

    const filter = isGitURL(this.input) ? '' : this.input.trim();

    const byLabel = new Map(this.candidates.map((candidate) => [candidate.label, candidate]));

    return pickMatches([...byLabel.keys()], filter).flatMap((label) => {
      const candidate = byLabel.get(label);

      if (candidate === undefined) {
        return [];
      }

      return [
        {
          label: candidate.detail === null ? label : `${label}  ${candidate.detail}`,
          candidate,
        },
      ];
    });
  }

  // The ref step's rows: the default branch first, then every branch and
  // tag in the order the upstream lists them, filtered by name.
  private collectRefItems(): ProbedRef[] {
    const refs = this.repo?.refs ?? [];
    const head = this.repo?.head ?? null;

    const ordered = [
      ...refs.filter((ref) => ref.kind === 'branch' && ref.name === head),
      ...refs.filter((ref) => !(ref.kind === 'branch' && ref.name === head)),
    ];

    const names = pickMatches([...new Set(ordered.map((ref) => ref.name))], this.input.trim());

    return names.flatMap((name) => ordered.filter((ref) => ref.name === name));
  }

  // Opens the source after the current one, wrapping round.
  private openNextSource() {
    const sources = this.sources ?? [];

    if (sources.length < 2) {
      return;
    }

    this.openSource((this.sourceIndex + 1) % sources.length);
  }

  private openSource(index: number) {
    const source = this.sources?.[index];

    if (source?.kind === 'path') {
      void this.openPathSource(index, null);
    } else if (source?.kind === 'git') {
      this.openGitSource(index, '', { kind: 'none' });
    }
  }

  // Lists a source of directories and opens the directory step on it, with
  // the client's own directory first. The flow stays where it is until the
  // listing answers, and an answer that comes after the flow moved on is
  // dropped.
  private async openPathSource(index: number, scope: string | null) {
    const source = this.sources?.[index];
    const generation = this.generation;

    this.requestSeq += 1;

    const seq = this.requestSeq;

    this.pathListingSeq = seq;

    let candidates: ListedCandidate[] = [];

    if (source !== undefined) {
      try {
        const answer = await this.deps.sendRequest('sources.list', {
          source: source.id,
          ...(scope === null ? {} : { scope }),
        });

        candidates = parseCandidates(answer['candidates']);
      } catch {}
    }

    if (this.isStale(generation) || this.pathListingSeq !== seq) {
      return;
    }

    this.pathListingSeq = null;

    const listed = candidates.flatMap((candidate) =>
      candidate.pick.kind === 'path' ? [[candidate.pick.dir, candidate.label] as const] : [],
    );

    this.sourceIndex = index;
    this.listingSeq = null;

    this.dirLabels = new Map(listed);

    this.dirs = [...new Set([process.cwd(), ...listed.map(([dir]) => dir)])];
    this.input = '';
    this.selected = 0;
    this.step = 'dir';

    process.stdout.write(ansi.clear);
    this.render();
  }

  // Moves the flow to a source of git repositories, carrying the typed text
  // across: the target step first when the daemon has more than one target
  // and the flow had no repository target yet, then the source step, which
  // acts as asked once it opens.
  private openGitSource(index: number, draft: string, action: SourceStepAction) {
    const fromGit = this.isGitFlow();

    this.pathListingSeq = null;
    this.sourceIndex = index;
    this.sourceDraft = draft;
    this.sourceAction = action;

    if (fromGit) {
      this.openSourceStep();

      return;
    }

    if (this.targets.length >= 2) {
      this.openTargetStep(() => {});
      process.stdout.write(ansi.clear);
      this.render();

      return;
    }

    this.target = this.targets[0] ?? null;

    this.openSourceStep();
  }

  // Opens the git source step with its draft, listing the source again
  // when the source or the target changed since the last listing.
  private openSourceStep() {
    this.step = 'source';
    this.input = this.sourceDraft;
    this.selected = 0;
    this.alternateURL = null;

    const action = this.sourceAction;

    this.sourceAction = { kind: 'none' };

    const key = `${this.findSource()?.id ?? ''}\n${this.target?.id ?? ''}`;
    const stale = this.listedKey !== key;

    if (stale) {
      this.listedKey = key;
      this.candidates = [];
      this.listedScope = null;
      this.listNotice = null;
    }

    process.stdout.write(ansi.clear);
    this.render();

    // A scope a reading asked for is listed in place of the source's own
    // default, for the target the step now has.
    if (action.kind === 'browse') {
      void this.loadCandidates(action.scope);
    } else if (stale) {
      void this.loadCandidates(null);
    }

    if (action.kind === 'probe') {
      void this.checkRepoAccess(this.sourceDraft, action.url);
    }
  }

  // The target every source request is made for: the chosen one, or none
  // for the daemon's default when there is no choice to make.
  private buildTargetParam(): Readonly<Record<string, string>> {
    return this.target === null ? {} : { target: this.target.id };
  }

  // Lists the git source's candidates behind the step, under a scope or
  // the source's own default. A daemon that cannot list them leaves a
  // notice row. Typing goes on meanwhile, and Esc stops the listing.
  private async loadCandidates(scope: string | null) {
    const source = this.findSource();
    const generation = this.generation;

    if (source === null) {
      return;
    }

    this.requestSeq += 1;

    const seq = this.requestSeq;

    this.listingSeq = seq;

    this.render();

    let answer: Readonly<Record<string, unknown>> | null = null;
    let failure: unknown = null;

    try {
      const params = {
        source: source.id,
        ...(scope === null ? {} : { scope }),
        ...this.buildTargetParam(),
      };

      answer = await this.deps.sendRequest('sources.list', params);
    } catch (error) {
      failure = error;
    }

    if (
      this.isStale(generation) ||
      this.listingSeq !== seq ||
      this.findSource()?.id !== source.id
    ) {
      return;
    }

    this.listingSeq = null;

    if (answer === null) {
      this.candidates = [];
      this.listedScope = scope;
      this.listNotice = `${formatListFailure(failure)} — type to enter one`;
    } else {
      this.candidates = parseCandidates(answer['candidates']);
      this.listedScope = typeof answer['scope'] === 'string' ? answer['scope'] : scope;

      this.listNotice =
        this.candidates.length === 0 && this.listedScope !== null
          ? `nothing listed for ${this.listedScope}`
          : null;
    }

    // The list answers behind the flow, so only the source step's own
    // selection starts over.
    if (this.step === 'source') {
      this.selected = 0;

      process.stdout.write(ansi.clear);
      this.render();
    }
  }

  // Takes the git source step's choice: the other URL form on offer, a
  // typed git URL, what the source reads typed text as, the selected
  // candidate, or else what another source reads the text as.
  private async applySourceSubmit() {
    const typed = this.input.trim();
    const item = this.collectCandidateItems()[this.selected];

    if (item?.url !== undefined) {
      await this.checkRepoAccess(item.url, item.url);

      return;
    }

    if (isGitURL(typed)) {
      await this.checkRepoAccess(typed, typed);

      return;
    }

    if (typed !== '') {
      const reading = await this.sendInterpret(this.sourceIndex, typed);

      if (reading === null) {
        return;
      }

      if (canTakeReading('git', reading)) {
        this.applyReading(this.sourceIndex, reading, typed);

        return;
      }
    }

    const candidate = item?.candidate;

    if (candidate?.pick.kind === 'git') {
      await this.checkRepoAccess(candidate.label, candidate.pick.url);

      return;
    }

    if (typed !== '') {
      await this.readTypedInput(typed, false);
    }
  }

  // Asks the sources in order what typed text is, the flow's own first when
  // asked, and moves the flow to the first that reads it as something its
  // kind takes. Text none reads is refused with the reason.
  private async readTypedInput(typed: string, withOwn: boolean) {
    const order = (this.sources ?? []).flatMap((_, index) =>
      index === this.sourceIndex ? [] : [index],
    );

    for (const index of withOwn ? [this.sourceIndex, ...order] : order) {
      const reading = await this.sendInterpret(index, typed);

      if (reading === null) {
        return;
      }

      if (canTakeReading(this.sources?.[index]?.kind, reading)) {
        this.applyReading(index, reading, typed);

        return;
      }
    }

    this.refusal = `no source reads ${typed} · esc back`;

    process.stdout.write(ansi.clear);
    this.render();
  }

  // Asks one source what typed text is. Null when Esc cancelled the
  // request; a refused request reads as nothing.
  private async sendInterpret(index: number, typed: string): Promise<Interpretation | null> {
    const source = this.sources?.[index];

    if (source === undefined) {
      return { kind: 'none' };
    }

    const answered = await this.sendPending('interpret', `reading ${typed}…`, 'sources.interpret', {
      source: source.id,
      input: typed,
      ...(source.kind === 'git' ? this.buildTargetParam() : {}),
    });

    if (answered === null) {
      return null;
    }

    return answered.ok ? parseInterpretation(answered.answer) : { kind: 'none' };
  }

  // Moves the flow to what a source read typed text as: its scope listed,
  // the directory chosen, or the repository probed.
  private applyReading(index: number, reading: Interpretation, typed: string) {
    if (reading.kind === 'none') {
      return;
    }

    if (reading.kind === 'path') {
      this.sourceIndex = index;

      this.applyDir(reading.dir);

      return;
    }

    const scope = reading.kind === 'browse' ? reading.scope : null;

    if (this.sources?.[index]?.kind === 'path') {
      void this.openPathSource(index, scope);

      return;
    }

    // The step lists the scope or probes the repository once it opens,
    // after any target step, so the request is made for the spawn's target.
    if (index !== this.sourceIndex || this.step !== 'source') {
      const action: SourceStepAction =
        reading.kind === 'git'
          ? { kind: 'probe', url: reading.url }
          : { kind: 'browse', scope: reading.scope };

      const draft = reading.kind === 'git' ? typed : '';

      this.openGitSource(index, draft, action);

      return;
    }

    if (reading.kind === 'browse') {
      this.input = '';
      void this.loadCandidates(reading.scope);

      return;
    }

    void this.checkRepoAccess(typed, reading.url);
  }

  // Sends a request the step waits on, and answers with its result, or
  // null when Esc cancelled it before the answer came.
  private async sendPending(
    kind: PendingRequest['kind'],
    label: string,
    m: string,
    p: Readonly<Record<string, unknown>>,
  ): Promise<
    | { readonly ok: true; readonly answer: Readonly<Record<string, unknown>> }
    | { readonly ok: false; readonly error: unknown }
    | null
  > {
    this.requestSeq += 1;

    const seq = this.requestSeq;
    const generation = this.generation;
    const esc = kind === 'spawn' ? 'esc stops waiting; the session still lists' : 'esc cancels';

    this.pending = { label: `${label} · ${esc}`, seq, kind };

    this.render();

    let result:
      | { readonly ok: true; readonly answer: Readonly<Record<string, unknown>> }
      | { readonly ok: false; readonly error: unknown };

    try {
      result = { ok: true, answer: await this.deps.sendRequest(m, p) };
    } catch (error) {
      result = { ok: false, error };
    }

    if (this.isStale(generation) || this.pending?.seq !== seq) {
      return null;
    }

    this.pending = null;

    return result;
  }

  // Checks that the daemon's host can read the repository at this URL for
  // the spawn's target, and opens the ref step with its refs. A failure
  // stays on the source step with git's error and offers the other URL
  // form the daemon returns, when there is one.
  private async checkRepoAccess(label: string, url: string) {
    const probed = await this.sendPending('probe', `checking access to ${url}…`, 'git.probe', {
      url,
      ...this.buildTargetParam(),
    });

    if (probed === null) {
      return;
    }

    if (!probed.ok) {
      this.alternateURL = findAlternateURL(probed.error);
      this.selected = 0;
      this.refusal = `${formatError(probed.error)} · esc back`;
      this.input = label;

      process.stdout.write(ansi.clear);
      this.render();

      return;
    }

    const repo = buildProbedRepo(label, url, probed.answer);

    // A destination typed for one repository is not meant for another.
    if (repo.url !== this.destinationRepoURL) {
      this.destinationEdited = false;
      this.destination = '';
    }

    this.repo = repo;
    this.ref = null;

    this.openRefStep();
    process.stdout.write(ansi.clear);
    this.render();
  }

  // Reads the repository's refs again after the commit the spawn pinned
  // left the upstream, and opens the ref step on them with the refusal.
  private async refreshRefs(reason: string) {
    const repo = this.repo;

    if (repo === null) {
      return;
    }

    this.openRefStep();

    const probed = await this.sendPending('probe', `re-reading refs of ${repo.url}…`, 'git.probe', {
      url: repo.url,
      ...this.buildTargetParam(),
    });

    if (probed === null) {
      return;
    }

    if (probed.ok) {
      this.repo = buildProbedRepo(repo.label, repo.url, probed.answer);
      this.refusal = `refs re-read · ${reason} · esc back`;
    } else {
      this.refusal = `${reason} · ${formatError(probed.error)} · esc back`;
    }

    process.stdout.write(ansi.clear);
    this.render();
  }

  private openRefStep() {
    this.step = 'ref';
    this.input = this.ref === null ? '' : (this.ref.ref ?? this.ref.sha);
    this.selected = 0;
  }

  private async applyRefSubmit() {
    const typed = this.input.trim();
    const named = this.repo?.refs.find((ref) => ref.name === typed);
    const item = this.collectRefItems()[this.selected];

    if (named !== undefined) {
      this.applyRef({ ref: named.name, sha: named.sha });

      return;
    }

    if (FULL_SHA_PATTERN.test(typed)) {
      this.applyRef({ ref: null, sha: typed });

      return;
    }

    // An abbreviated commit id could name another commit by the time the
    // clone runs, so only a full one pins the checkout.
    if (SHORT_SHA_PATTERN.test(typed)) {
      this.refusal = 'full commit id required · esc back';

      this.render();

      return;
    }

    if (item !== undefined) {
      this.applyRef({ ref: item.name, sha: item.sha });

      return;
    }

    if (typed === '' || this.repo === null) {
      return;
    }

    // A ref the listing leaves out, such as `refs/tags/v1`, is resolved by
    // the daemon the way the spawn would resolve it.
    const probed = await this.sendPending('probe', `resolving ${typed}…`, 'git.probe', {
      url: this.repo.url,
      ref: typed,
      ...this.buildTargetParam(),
    });

    if (probed === null) {
      return;
    }

    const resolved =
      probed.ok && isRecord(probed.answer['resolved']) ? probed.answer['resolved'] : {};

    if (typeof resolved['sha'] === 'string') {
      this.applyRef({ ref: typed, sha: resolved['sha'] });

      return;
    }

    this.refusal = probed.ok
      ? `the daemon resolved no commit for ${typed} · esc back`
      : `${formatError(probed.error)} · esc back`;

    process.stdout.write(ansi.clear);
    this.render();
  }

  private applyRef(ref: ChosenRef) {
    // A default destination belongs to the commit it was built for.
    if (!this.destinationEdited) {
      this.destination = '';
    }

    this.ref = ref;
    this.input = '';

    this.openConfirmStep();
    process.stdout.write(ansi.clear);
    this.render();
  }

  // Opens the confirm screen with the destination the user last accepted,
  // else the default under the target's workspace root. A root the target
  // cannot take leaves the destination empty with the reason.
  private openConfirmStep() {
    this.step = 'confirm';
    this.destinationAttempt = 1;

    if (this.destination === '' && this.repo !== null && this.ref !== null) {
      const target = this.findEffectiveTarget();

      const root = resolveWorkspaceRoot(this.workspaces, {
        id: target?.id ?? 'local',
        inPlace: target?.inPlace ?? true,
      });

      if (root.ok) {
        this.destinationRepoURL = this.repo.url;

        this.destination = buildWorkspaceDestination({
          root: root.root,
          url: this.repo.url,
          ref: this.ref.ref,
          sha: this.ref.sha,
        });
      } else {
        this.refusal = root.message;
      }
    }

    this.input = this.buildDestination();
  }

  // Takes the confirm screen's destination: absolute on its target, with a
  // leading `~` expanded only on the daemon's own machine. False, with the
  // reason shown, when the target cannot take it.
  private applyDestination(typed: string): boolean {
    const inPlace = this.findEffectiveTarget()?.inPlace ?? true;

    const dir =
      inPlace && (typed === '~' || typed.startsWith('~/'))
        ? `${resolveHomeDir()}${typed.slice(1)}`
        : typed;

    if (!dir.startsWith('/')) {
      this.refusal = inPlace
        ? 'the destination must be an absolute path'
        : 'the destination must be an absolute path on the target; ~ is not expanded there';

      return false;
    }

    if (dir !== this.buildDestination()) {
      this.destination = dir;
      this.destinationAttempt = 1;
      this.destinationEdited = true;
    }

    this.destinationRepoURL = this.repo?.url ?? null;
    this.dir = this.buildDestination();

    return true;
  }

  // The destination with the suffix a refused spawn added.
  private buildDestination(): string {
    return this.destinationAttempt === 1
      ? this.destination
      : `${this.destination}-${this.destinationAttempt}`;
  }

  private formatDestination(): string {
    return `${this.findEffectiveTarget()?.id ?? 'local'}:${this.buildDestination()}`;
  }

  // The target the spawn runs on: the chosen one, else the daemon's
  // default, else null when the daemon lists no targets.
  private findEffectiveTarget(): TargetPick | null {
    return this.target ?? this.targets.find((t) => t.isDefault) ?? null;
  }

  // Opens the target step when the daemon has more than one target, and
  // the fallback step otherwise. The chosen target is selected, else for a
  // repository the default when it takes a workspace and the first target
  // that does when it does not, else the default.
  private openTargetStep(fallback: () => void) {
    if (this.targets.length < 2) {
      // The one target is the spawn's, default or not, so the spawn names it
      // and its provider decides whether a directory runs in place.
      this.target = this.targets[0] ?? null;

      fallback();

      return;
    }

    const preferred =
      this.target ??
      (this.isGitFlow()
        ? (this.targets.find((t) => t.isDefault && t.takesWorkspace) ??
          this.targets.find((t) => t.takesWorkspace))
        : undefined) ??
      this.targets.find((t) => t.isDefault);

    this.selected = Math.max(
      0,
      this.targets.findIndex((t) => t.id === preferred?.id),
    );

    this.input = '';
    this.step = 'target';
  }

  // Reads the daemon's targets and sources once the agent is chosen, and
  // opens the first source: the first of directories for an adopt, and the
  // local directory flow for a daemon that offers no sources.
  private async openFirstSource() {
    const generation = this.generation;
    let listed: Readonly<Record<string, unknown>> = {};

    try {
      listed = await this.deps.sendRequest('agents.list');
    } catch {}

    if (this.isStale(generation)) {
      return;
    }

    const picks = collectTargetPicks(listed);

    // An adopt resumes a session from its history on this host, which a
    // fresh checkout elsewhere does not hold, so it is offered only the
    // targets that run here.
    this.targets = this.resume ? picks.filter((t) => t.available && t.inPlace) : picks;

    const announced = parseAnnouncedSources(listed['sources']);
    const index = this.resume ? announced.findIndex((source) => source.kind === 'path') : 0;

    if (announced.length > 0 && index !== -1) {
      this.sources = announced;

      this.openSource(index);

      return;
    }

    this.sources = null;

    await this.openLocalDirs(generation);
  }

  // The local directory flow of a daemon that offers no sources: the
  // client's own directory, the daemon's spawn history, the configured
  // roots, and zoxide's list on this host.
  private async openLocalDirs(generation: number) {
    let recent: string[] = [];

    try {
      const answer = await this.deps.sendRequest('dirs.list');

      const dirs = answer['dirs'];

      if (Array.isArray(dirs)) {
        recent = dirs.filter((d): d is string => typeof d === 'string');
      }
    } catch {}

    const zoxide = await collectZoxideDirs();

    if (this.isStale(generation)) {
      return;
    }

    this.dirs = collectDirs({ cwd: process.cwd(), recent, roots: this.roots, zoxide });

    this.dirLabels = new Map();

    this.sourceIndex = -1;
    this.input = '';
    this.selected = 0;
    this.step = 'dir';

    process.stdout.write(ansi.clear);
    this.render();
  }

  private async spawn(prompt: string) {
    const params = {
      cwd: this.dir,
      name: this.name,
      prompt,
      cols: cols(),
      rows: this.deps.ptyRows(),
      ...(this.resume ? { resume: true } : {}),
      agent: this.agent,
      ...this.buildSourceParams(),
    };

    const label = this.isGitFlow() ? 'materializing the workspace…' : 'spawning…';

    const spawned = await this.sendPending('spawn', label, 'session.spawn', params);

    if (spawned === null) {
      return;
    }

    if (!spawned.ok) {
      this.applySpawnRefusal(spawned.error, prompt);

      return;
    }

    const session = this.deps.toMirrorSession(spawned.answer['session']);

    if (session === null) {
      this.quitFlow();

      return;
    }

    this.stopFlow();
    this.deps.upsertMirror(session);

    await this.deps.attach(session.id);
  }

  // A refused git workspace spawn returns to the step that can fix it. Any
  // other refusal keeps the picker on the step that sent it, with the
  // entered text back in the input, so the user can fix the cause and retry
  // or back out.
  private applySpawnRefusal(error: unknown, prompt: string) {
    const reason = formatError(error);
    const code = error instanceof DaemonError ? error.code : 'internal';
    const step = this.isGitFlow() ? pickRefusalStep(code) : null;

    if (step === 'ref') {
      void this.refreshRefs(reason);

      return;
    }

    if (step === 'destination') {
      this.destinationAttempt += 1;
      this.step = 'confirm';
      this.input = this.buildDestination();
      this.refusal = `${reason} · ⏎ use ${this.buildDestination()} · esc back`;
    } else if (step === 'source') {
      this.input = this.repo?.label ?? '';
      this.repo = null;
      this.step = 'source';
      this.refusal = `${reason} · esc back`;
    } else if (step === 'confirm') {
      const phase =
        error instanceof DaemonError && typeof error.data?.['phase'] === 'string'
          ? ` while ${error.data['phase']}`
          : '';

      this.step = 'confirm';
      this.input = this.buildDestination();
      this.refusal = `${reason}${phase} · esc back`;
    } else {
      this.refusal = `${reason} · ⏎ retry · esc back`;
      this.input = this.resume ? this.name : prompt;
    }

    process.stdout.write(ansi.clear);
    this.render();
  }

  // What the spawn sends for its source. A git repository goes as a git
  // workspace at the commit the confirm screen showed, with the ref it was
  // chosen by. A chosen target goes with the spawn; a local directory runs
  // in place when the spawn's target is on the daemon's own machine, and is
  // materialized at the same path from its pushed HEAD on any other.
  private buildSourceParams(): Readonly<Record<string, unknown>> {
    const target = this.buildTargetParam();

    if (this.isGitFlow() && this.repo !== null && this.ref !== null) {
      return {
        ...target,
        workspace: {
          kind: 'git',
          url: this.repo.url,
          ...(this.ref.ref === null ? {} : { ref: this.ref.ref }),
          sha: this.ref.sha,
        },
      };
    }

    const effective = this.findEffectiveTarget();

    if (effective === null || effective.inPlace) {
      return target;
    }

    return { ...target, workspace: { kind: 'path', path: this.dir } };
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

// Why a source cannot run on a target, or null when it can. A git
// repository needs a target that takes a workspace; a local directory also
// runs in place on the daemon's own machine.
function findTargetRefusal(pick: TargetPick, git: boolean): string | null {
  if (!pick.available) {
    return `target '${pick.id}' is unavailable on this daemon · esc back`;
  }

  if (!pick.takesWorkspace && (git || !pick.inPlace)) {
    return `target '${pick.id}' cannot take a workspace · esc back`;
  }

  return null;
}

// Whether a source of a kind can act on a reading: a scope it lists, or a
// pick of its own kind.
function canTakeReading(
  kind: AnnouncedSource['kind'] | undefined,
  reading: Interpretation,
): boolean {
  return reading.kind === 'browse' || (reading.kind !== 'none' && reading.kind === kind);
}

function formatRef(ref: ProbedRef, head: string | null): string {
  const notes = [
    ...(ref.kind === 'tag' ? ['tag'] : []),
    ...(ref.kind === 'branch' && ref.name === head ? ['default'] : []),
    ref.sha.slice(0, 7),
  ];

  return `${ref.name}  ${notes.join(' · ')}`;
}

function formatError(error: unknown): string {
  return error instanceof DaemonError ? `${error.code}: ${error.message}` : String(error);
}

// Why the daemon gave no list, in the words the notice row uses.
function formatListFailure(error: unknown): string {
  if (!(error instanceof DaemonError)) {
    return String(error);
  }

  if (error.code === 'unknown_method') {
    return 'this daemon cannot list sources';
  }

  return error.message;
}

// The other URL form a refused probe holds, or null when it holds none.
function findAlternateURL(error: unknown): string | null {
  const alternates = error instanceof DaemonError ? error.data?.['alternates'] : undefined;
  const first: unknown = Array.isArray(alternates) ? alternates[0] : undefined;

  return typeof first === 'string' ? first : null;
}

function buildProbedRepo(
  label: string,
  url: string,
  answer: Readonly<Record<string, unknown>>,
): ProbedRepo {
  return {
    label,
    url: typeof answer['url'] === 'string' ? answer['url'] : url,
    head: typeof answer['head'] === 'string' ? answer['head'] : null,
    refs: parseProbedRefs(answer['refs']),
  };
}

function parseAnnouncedSources(raw: unknown): AnnouncedSource[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry: unknown): AnnouncedSource[] =>
    isRecord(entry) &&
    typeof entry['id'] === 'string' &&
    typeof entry['label'] === 'string' &&
    (entry['kind'] === 'git' || entry['kind'] === 'path')
      ? [{ id: entry['id'], label: entry['label'], kind: entry['kind'] }]
      : [],
  );
}

function parseCandidates(raw: unknown): ListedCandidate[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry: unknown): ListedCandidate[] => {
    if (!isRecord(entry) || typeof entry['label'] !== 'string') {
      return [];
    }

    const pick = parsePick(entry['pick']);

    return pick === null
      ? []
      : [
          {
            label: entry['label'],
            detail: typeof entry['detail'] === 'string' ? entry['detail'] : null,
            pick,
          },
        ];
  });
}

function parseInterpretation(answer: Readonly<Record<string, unknown>>): Interpretation {
  if (answer['kind'] === 'browse' && typeof answer['scope'] === 'string') {
    return { kind: 'browse', scope: answer['scope'] };
  }

  return parsePick(answer) ?? { kind: 'none' };
}

function parsePick(raw: unknown): SourcePick | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (raw['kind'] === 'path' && typeof raw['dir'] === 'string') {
    return { kind: 'path', dir: raw['dir'] };
  }

  if (raw['kind'] === 'git' && typeof raw['url'] === 'string') {
    return { kind: 'git', url: raw['url'] };
  }

  return null;
}

function parseProbedRefs(raw: unknown): ProbedRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry: unknown): ProbedRef[] =>
    isRecord(entry) &&
    typeof entry['name'] === 'string' &&
    typeof entry['sha'] === 'string' &&
    (entry['kind'] === 'branch' || entry['kind'] === 'tag')
      ? [{ name: entry['name'], kind: entry['kind'], sha: entry['sha'] }]
      : [],
  );
}
