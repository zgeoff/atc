import type { WorkspacesConfig } from '@atc/config';
import { DEFAULT_GIT_TRANSPORTS, LOCAL_TARGET, loadConfig } from '@atc/config';
import type { AgentID, Clock } from '@atc/core';
import {
  COMMIT_ID_PATTERN,
  ansi,
  buildWorkspaceDestination,
  expandHome,
  isGitURL,
  isHomeRelative,
  isPathInput,
  isRecord,
} from '@atc/core';
import type { GitRef, SourceEntry, SourceInterpretation, SourcePick } from '@atc/protocol';
import {
  GIT_REF_SCHEMA,
  SOURCE_CANDIDATE_SCHEMA,
  SOURCE_ENTRY_SCHEMA,
  SOURCE_INTERPRETATION_SCHEMA,
} from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { collectTargetPicks } from './collect-target-picks';
import type { TargetPick } from './collect-target-picks';
import { formatDir, formatDirName, pickMatches } from './dirs';
import { KEY, planTextEdit } from './keys';
import type { ListingCache } from './open-listing-cache';
import { pickRefusalStep } from './pick-refusal-step';
import { readAgentPicks } from './read-agent-picks';
import type { AgentPick } from './read-agent-picks';
import { resolveWorkspaceRoot } from './resolve-workspace-root';
import { splitToWidth } from './split-to-width';
import { cols, drawPicker, getPickerWidth } from './ui';

type PickerStep =
  | 'agent'
  | 'dir'
  | 'source'
  | 'ref'
  | 'target'
  | 'confirm'
  | 'name'
  | 'prompt'
  | 'spawned';

// The kinds of answer the flow can drop: each source's listing, each
// request a step waits on, the daemon's targets and sources, and a remote
// daemon's path completions.
export type DroppedAnswer =
  | 'listing'
  | 'directory listing'
  | 'path completion'
  | 'interpret'
  | 'probe'
  | 'spawn'
  | 'targets and sources';

// What the flow borrows from the client that owns the screen, the daemon
// connection and the fleet mirror.
export interface SpawnPickerDeps<TMirror> {
  readonly sendRequest: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly ptyRows: () => number;
  readonly isLeaderKey: (buf: Buffer) => boolean;
  readonly getLastUsedAgent: () => AgentID;
  readonly scheduleStatus: () => void;
  readonly showBase: () => void;
  readonly attach: (sessionID: string) => Promise<void>;
  readonly toMirrorSession: (value: unknown) => TMirror | null;
  readonly upsertMirror: (session: Readonly<TMirror>) => void;

  // Where the flow draws: every byte of the picker's screen goes through it.
  readonly write: (chunk: string) => void;

  // The client's own directory, which the directory step lists first and a
  // local daemon reads a typed relative path under.
  readonly cwd: string;

  // The client's home directory, which a typed `~` expands to.
  readonly home: string;

  // Whether the daemon runs on another host, where the client's own
  // directory stands for nothing.
  readonly remoteDaemon?: boolean;

  // The config file the flow reads its agents, roots, and workspaces from
  // each time it opens.
  readonly configPath: string;

  // a dropped answer from a stale flow or request changes nothing; a dropped listing for a
  // source the flow left only clears the pending listing, so that source lists again when
  // its step reopens.
  readonly onDropAnswer?: (kind: DroppedAnswer) => void;

  // Records any other decision the flow takes without drawing anything,
  // such as text it ignores on a step that takes none.
  readonly log?: (line: string) => void;

  // The git listings the source step shows at once while it lists again,
  // kept per daemon socket, source, target, and scope; none are kept
  // when unset.
  readonly listingCache?: ListingCache;

  // The socket of the daemon the client reaches, which keys the listings.
  readonly getDaemonSocketPath?: () => string;

  // The time a cached listing's age is read from, and the timer a typed
  // path waits on before the flow asks the daemon to complete it.
  readonly clock: Clock;
}

// How long typing pauses before the flow asks the daemon to complete a
// typed path, so a burst of keys sends one request.
const COMPLETION_DELAY_MS = 120;

// One source `agents.list` returned, in the order the daemon offers them.
// One candidate `sources.list` returned.
interface ListedCandidate {
  readonly label: string;
  readonly detail: string | null;
  readonly pick: SourcePick;
}

// The repository the probe proved the daemon's host can read.
interface ProbedRepo {
  // What the user chose, shown as the source step's input on the way back
  // to it.
  readonly label: string;

  // The URL the clone fetches, as the daemon resolved it.
  readonly url: string;
  readonly head: string | null;
  readonly refs: readonly GitRef[];
}

// The commit the spawn checks out, and the branch or tag it came from.
interface ChosenRef {
  readonly ref: string | null;
  readonly sha: string;
}

// The root the daemon picks a destination under on a remote target without
// a configured one, as the confirm screen shows it.
const AUTO_ROOT = '~/.local/share/atc/workspaces';
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

export class SpawnPicker<TMirror extends { readonly id: string }> {
  private readonly deps: SpawnPickerDeps<TMirror>;

  private step: PickerStep = 'agent';

  // The sources the daemon offers, and the one the flow is on; -1 before
  // the flow opens one.
  private sources: readonly SourceEntry[] = [];

  private sourceIndex = -1;

  private input = '';

  private selected = 0;

  // The installed agents, collected each time the menu opens so a config
  // edit or a fresh install lands without a client restart.
  private picks: AgentPick[] = [];

  // Whether the agent step waits on the daemon's targets and sources once
  // an agent is chosen.
  private sourcesPending = false;

  // The directories the directory step lists, and the label each shows.
  private dirs: string[] = [];

  private dirLabels: ReadonlyMap<string, string> = new Map();

  // The daemon's completions of a typed path with the label each shows, for
  // the input they complete, the completion request the flow waits on, and
  // the timer that sends the next one.
  private completed: {
    readonly input: string;
    readonly labels: ReadonlyMap<string, string>;
  } | null = null;

  private completionSeq: number | null = null;

  private cancelCompletionTimer: (() => void) | null = null;

  // The configured workspace settings, read with the agents each time the
  // menu opens.
  private workspaces: WorkspacesConfig = {
    githubOwner: null,
    sources: null,
    gitTransports: DEFAULT_GIT_TRANSPORTS,
    root: null,
    targetRoots: new Map(),
  };

  private directory = '';

  // The daemon's execution targets, read when the agent is chosen, and the
  // one chosen; null spawns on the daemon's default target.
  private targets: TargetPick[] = [];

  private target: TargetPick | null = null;

  // Why the flow offers no target although the daemon lists some, or null
  // when it offers some or the daemon lists none.
  private targetGap: string | null = null;

  // the git source's candidates, or the notice standing in for a list the daemon could not
  // give, for the source and target they were listed for. A listing runs behind the step,
  // so typing goes on.
  private candidates: ListedCandidate[] = [];

  private listedScope: string | null = null;

  private listNotice: string | null = null;

  private listedKey: string | null = null;

  private listingSeq: number | null = null;

  // When the shown candidates were listed, if they came from the listing
  // cache rather than from a listing the step made, and why the listing
  // that would replace them failed.
  private listedFrom: number | null = null;

  private refreshFailure: string | null = null;

  // The scope the step last asked for, which a refresh asks for again.
  private requestedScope: string | null = null;

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

  // The directory the daemon picks on the target when the confirm screen
  // has no destination it can build, under the target user's home as the
  // screen shows it, or null when the spawn gives its own.
  private autoDestination: string | null = null;

  private name = '';

  private resume = false;

  private agent: AgentID = 'claude';

  // Why the last action was refused, shown in place of the hint until the
  // next key.
  private refusal: string | null = null;

  private pending: PendingRequest | null = null;

  // A session the daemon started with warnings, and those warnings, shown
  // before the flow attaches it.
  private spawned: TMirror | null = null;

  private spawnedWarnings: readonly string[] = [];

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

    const config = loadConfig(SHIPPED_HARNESS_PLUGINS, this.deps.configPath);

    this.picks = readAgentPicks(config);
    this.workspaces = config.workspaces;
    this.input = '';
    this.sources = [];
    this.sourceIndex = -1;
    this.sourcesPending = false;
    this.target = null;
    this.targetGap = null;
    this.repo = null;
    this.ref = null;
    this.sourceDraft = '';
    this.sourceAction = { kind: 'none' };
    this.listedKey = null;
    this.listingSeq = null;
    this.pathListingSeq = null;
    this.completed = null;
    this.completionSeq = null;

    this.stopCompletionTimer();

    this.alternateURL = null;
    this.destination = '';
    this.destinationEdited = false;
    this.destinationRepoURL = null;
    this.autoDestination = null;

    // A last-used agent that is no longer installed is not in the menu, so
    // the selection falls to the first one that is.
    this.selected = Math.max(
      0,
      this.picks.findIndex((pick) => pick.agent === this.deps.getLastUsedAgent()),
    );

    this.agent = this.picks[this.selected]?.agent ?? this.deps.getLastUsedAgent();
    this.step = 'agent';
    this.refusal = null;
    this.pending = null;

    this.deps.write(ansi.clear);

    // One installed agent is no choice to make, so the flow goes on with it.
    if (this.picks.length === 1) {
      void this.openFirstSource();

      return;
    }

    this.render();
  }

  applyKey(buf: Buffer) {
    this.refusal = null;

    if (this.step === 'spawned') {
      this.applySpawnedKey(buf);

      return;
    }

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

    // The agent step waiting on the daemon's targets and sources takes Esc
    // and the leader, and every other key waits for the answer.
    if (
      this.step === 'agent' &&
      this.sourcesPending &&
      edit.kind !== 'cancel' &&
      edit.kind !== 'leader'
    ) {
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

    // Ctrl-R lists the git source step's scope again.
    if (
      this.step === 'source' &&
      edit.kind !== 'leader' &&
      buf.length === 1 &&
      buf[0] === KEY.ctrlR
    ) {
      this.refreshCandidates();

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
      let hint = '↑↓ move · ⏎ select · esc cancel';

      if (this.picks.length === 0) {
        hint = 'no agent CLI found — set agents in config.json · esc cancel';
      } else if (this.sourcesPending) {
        hint = 'reading targets and sources… · esc cancel';
      }

      drawPicker(
        {
          title: `${verb}: agent`,
          items: this.picks.map((pick) => pick.label),
          selected: this.selected,
          input: this.input,
          hint: this.refusal ?? hint,
        },
        this.deps.write,
      );
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
    } else if (this.step === 'spawned') {
      drawPicker(
        {
          title: `${verb}: started`,
          items: this.spawnedWarnings.flatMap((warning) =>
            splitToWidth(warning, getPickerWidth() - 4),
          ),
          selected: -1,
          input: '',
          hint: '⏎ attach · esc back',
        },
        this.deps.write,
      );
    } else if (this.step === 'name') {
      const where = this.isGitFlow() ? this.formatDestination() : formatDir(this.directory);

      drawPicker(
        {
          title: `${verb}: name`,
          items: [],
          selected: -1,
          input: this.input,
          placeholder: formatDirName(this.autoDestination ?? this.directory),
          hint: this.refusal ?? `session name for ${where} · ⏎ accept · esc back`,
        },
        this.deps.write,
      );
    } else {
      drawPicker(
        {
          title: 'spawn: initial prompt',
          items: [],
          selected: -1,
          input: this.input,
          placeholder: 'optional — ⏎ to start interactive',
          hint:
            this.pending?.label ??
            this.refusal ??
            'first message for the session · ⏎ spawn · esc back',
        },
        this.deps.write,
      );
    }

    this.deps.scheduleStatus();
  }

  // Leaves the flow for the screen it came from, dropping every answer
  // still on its way.
  private quitFlow() {
    this.stopFlow();
    this.deps.showBase();
  }

  // Ends the flow's generation: no request it sent changes anything when
  // its answer comes.
  stopFlow() {
    this.generation += 1;
    this.pending = null;
    this.listingSeq = null;
    this.pathListingSeq = null;

    this.stopCompletionTimer();
  }

  private stopCompletionTimer() {
    this.cancelCompletionTimer?.();
    this.cancelCompletionTimer = null;
  }

  // Whether an answer belongs to a flow that has since ended.
  private isStale(generation: number): boolean {
    return generation !== this.generation;
  }

  private renderDirStep(verb: string) {
    // This host's home stands for nothing on a remote daemon's host, so a
    // remote daemon's path shows the label the daemon gave it, or else as it
    // is.
    const items = this.collectDirItems().map(
      (directory) =>
        this.completed?.labels.get(directory) ??
        this.dirLabels.get(directory) ??
        (this.deps.remoteDaemon === true ? directory : formatDir(directory)),
    );

    this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

    drawPicker(
      {
        title: `${verb}: ${this.findSource()?.label ?? 'directory'}`,
        items,
        selected: this.selected,
        input: this.input,
        hint:
          this.pending?.label ??
          this.refusal ??
          `type to filter, or a path (/ ~ .) · ↑↓ move · ⏎ select${this.formatTabHint()} · esc cancel`,
      },
      this.deps.write,
    );
  }

  private renderTargetStep(verb: string) {
    this.selected = Math.min(this.selected, this.targets.length - 1);

    const git = this.isGitFlow();
    const what = git ? 'the repository' : formatDir(this.directory);
    let hint = `where ${what} runs · ↑↓ move · ⏎ select · esc back`;

    // A step with no target the source can run on says what is missing.
    if (this.collectEligibleTargets().length === 0) {
      const gap = this.targetGap ?? `none of these targets can run ${what}`;

      hint = `${gap} · set targets in config.json · esc back`;
    }

    drawPicker(
      {
        title: `${verb}: target`,
        items: this.targets.map((target) => formatTargetPick(target)),
        selected: this.selected,
        input: '',
        hint: this.refusal ?? hint,
        dimmed: new Set(
          this.targets.flatMap((target, index) =>
            target.takesWorkspace || (!git && target.available && target.inPlace) ? [] : [index],
          ),
        ),
      },
      this.deps.write,
    );
  }

  private renderSourceStep() {
    const items = this.collectCandidateItems();

    this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

    const scope = this.listedScope === null ? '' : ` · ${this.listedScope}`;
    let listing: string | null = null;
    let age = '';

    // A cached listing shows its age in the title while the step lists
    // again, and the failure in the hint when that listing fails.
    if (this.listedFrom !== null) {
      const refreshing = this.listingSeq === null ? '' : ', refreshing…';

      age = ` · ${formatAge(this.getNow() - this.listedFrom)} old${refreshing}`;

      if (this.refreshFailure !== null && this.listingSeq === null) {
        listing = `refresh failed: ${this.refreshFailure} · ^r retry · esc back`;
      }
    } else if (this.listingSeq !== null) {
      listing = 'listing… · esc stops';
    }

    drawPicker(
      {
        title: `spawn: ${this.findSource()?.label ?? ''}${scope}${age}`,
        items: items.map((item) => item.label),
        selected: items.length === 0 || items[0]?.notice === true ? -1 : this.selected,
        input: this.input,
        hint:
          this.pending?.label ??
          this.refusal ??
          listing ??
          `type to filter, or a git URL · ↑↓ move · ⏎ select · ^r refresh${this.formatTabHint()} · esc back`,
        dimmed: new Set(items.flatMap((item, index) => (item.notice === true ? [index] : []))),
      },
      this.deps.write,
    );
  }

  private renderRefStep() {
    const items = this.collectRefItems();

    this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

    drawPicker(
      {
        title: `spawn: ref · ${this.repo?.label ?? ''}`,
        items: items.map((item) => formatRef(item, this.repo?.head ?? null)),
        selected: items.length === 0 ? -1 : this.selected,
        input: this.input,
        hint:
          this.pending?.label ??
          this.refusal ??
          'branch, tag, or full commit id · ↑↓ move · ⏎ select · esc back',
      },
      this.deps.write,
    );
  }

  private renderConfirmStep() {
    const ref = this.ref;
    const target = this.findEffectiveTarget();
    let refRow = '';

    if (ref !== null) {
      refRow = ref.ref === null ? `commit ${ref.sha}` : `${ref.ref} → ${ref.sha.slice(0, 12)}`;
    }

    drawPicker(
      {
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
        placeholder:
          this.autoDestination === null
            ? 'destination on the target'
            : 'picked on the target · or type an absolute path',
        hint: this.refusal ?? 'destination on the target · ⏎ continue · esc back',
      },
      this.deps.write,
    );
  }

  // The source the flow is on, or null before the flow opens one.
  private findSource(): SourceEntry | null {
    return this.sources[this.sourceIndex] ?? null;
  }

  // Whether the flow is choosing a git repository rather than a directory.
  private isGitFlow(): boolean {
    return this.findSource()?.kind === 'git';
  }

  // The hint that Tab moves to the next source, when there is one to move
  // to.
  private formatTabHint(): string {
    if (this.resume || this.sources.length < 2) {
      return '';
    }

    const next = this.sources[(this.sourceIndex + 1) % this.sources.length];

    return next === undefined ? '' : ` · tab ${next.label}`;
  }

  private applyInput(value: string) {
    // The target step takes no text: its list is short and fixed.
    if (this.step === 'target') {
      this.deps.log?.('ignored text on the target step');

      return;
    }

    this.input = value;

    if (this.step === 'source') {
      this.alternateURL = null;
    }

    // A pasted URL in the directory step is a repository, not a path, so
    // the flow moves to the first source of repositories with it.
    if (this.step === 'dir' && !this.resume && isGitURL(value) && !value.startsWith('/')) {
      const index = this.sources.findIndex((source) => source.kind === 'git');

      if (index !== -1) {
        this.openGitSource(index, value, { kind: 'none' });

        return;
      }
    }

    this.stopCompletionTimer();

    if (this.step === 'dir' && isPathInput(value)) {
      this.cancelCompletionTimer = this.deps.clock.schedule(() => {
        this.cancelCompletionTimer = null;
        void this.loadCompletions(value);
      }, COMPLETION_DELAY_MS);
    }

    this.render();
  }

  // Asks the daemon to complete a typed path on its own host. Only the
  // latest request's answer draws, so an earlier answer is dropped even
  // when the input has come back to the text it completes.
  private async loadCompletions(input: string) {
    const own = this.findSource();

    const source =
      own?.kind === 'path' ? own : this.sources.find((candidate) => candidate.kind === 'path');

    if (source === undefined) {
      return;
    }

    const generation = this.generation;

    this.requestSeq += 1;

    const seq = this.requestSeq;

    this.completionSeq = seq;

    let candidates: ListedCandidate[] = [];
    let failure: string | null = null;

    try {
      const answer = await this.deps.sendRequest('sources.complete', {
        source: source.id,
        input,
        ...this.buildPathTargetParam(),
        ...this.buildClientCwdParam(),
      });

      candidates = parseCandidates(answer['completions']);
    } catch (error) {
      failure = formatError(error);
    }

    if (
      this.isStale(generation) ||
      this.completionSeq !== seq ||
      this.step !== 'dir' ||
      this.input !== input
    ) {
      this.deps.onDropAnswer?.('path completion');

      return;
    }

    this.completionSeq = null;

    // A refused completion is no empty one: the step shows why until the
    // next key, and the input completes again on that key.
    if (failure !== null) {
      this.deps.log?.(`path completion failed: ${failure}`);
      this.refusal = `cannot complete ${input}: ${failure}`;
      this.completed = null;

      this.render();

      return;
    }

    const labels = new Map(
      candidates.flatMap((candidate) =>
        candidate.pick.kind === 'path'
          ? [[candidate.pick.directory, candidate.label] as const]
          : [],
      ),
    );

    this.completed = { input, labels };

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

    this.deps.write(ansi.clear);
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

    // Esc first stops a listing in flight, keeping the step, unless the
    // step shows a cached listing meanwhile.
    if (this.step === 'source' && this.listingSeq !== null && this.listedFrom === null) {
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

      return;
    }

    if (this.step === 'source') {
      this.sourceDraft = typed;

      this.applySourceCancel();

      return;
    }

    if (this.step === 'ref') {
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
      } else if (!this.openTargetStep()) {
        this.step = 'dir';
      }
    } else {
      this.input = this.name;
      this.step = 'name';
    }

    this.deps.write(ansi.clear);
    this.render();
  }

  // Goes back to the agent step, or leaves the flow when one installed
  // agent left no agent step to go back to.
  private openAgentStep() {
    if (this.picks.length === 1) {
      this.quitFlow();

      return;
    }

    this.selected = Math.max(
      0,
      this.picks.findIndex((pick) => pick.agent === this.agent),
    );

    this.sourcesPending = false;
    this.step = 'agent';

    this.deps.write(ansi.clear);
    this.render();
  }

  // Leaves a git source step backwards: to the target step when the spawn
  // has one, else to the agent.
  private applySourceCancel() {
    if (this.openTargetStep()) {
      this.deps.write(ansi.clear);
      this.render();

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

      this.deps.write(ansi.clear);
      this.render();

      return;
    }

    const index = this.sources.findIndex((source) => source.kind === 'path');

    if (index === -1) {
      this.openAgentStep();

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

    this.deps.write(ansi.clear);
    this.render();
  }

  // Takes the directory step's choice: a listed or completed directory, a
  // typed path, or else what the sources read the text as. A remote daemon
  // resolves a typed path itself, through its source of directories.
  private async applyDirSubmit() {
    const typed = this.input.trim();
    const chosen = this.collectDirItems()[this.selected];

    if (chosen !== undefined) {
      this.applyDir(chosen);

      return;
    }

    if (typed !== '') {
      await this.readTypedInput(typed, true);
    }
  }

  private applyDir(directory: string) {
    this.directory = directory;
    this.input = '';

    if (!this.openTargetStep()) {
      this.step = 'name';
    }

    this.deps.write(ansi.clear);
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

    this.deps.write(ansi.clear);
    this.render();
  }

  private collectDirItems(): string[] {
    if (!isPathInput(this.input)) {
      return pickMatches(this.dirs, this.input);
    }

    return this.completed?.input === this.input ? [...this.completed.labels.keys()] : [];
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
  private collectRefItems(): GitRef[] {
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
    if (this.sources.length < 2) {
      this.deps.log?.('ignored tab with one source');

      return;
    }

    this.openSource((this.sourceIndex + 1) % this.sources.length);
  }

  private openSource(index: number) {
    const source = this.sources[index];

    if (source?.kind === 'path') {
      void this.openPathSource(index, null);
    } else if (source?.kind === 'git') {
      this.openGitSource(index, '', { kind: 'none' });
    }
  }

  // the client's own directory lists first, unless the daemon runs on another host. The flow
  // stays where it is until the listing answers, and an answer that comes after the flow
  // moved on is dropped.
  private async openPathSource(index: number, scope: string | null) {
    const source = this.sources[index];
    const generation = this.generation;

    this.requestSeq += 1;

    const seq = this.requestSeq;

    this.pathListingSeq = seq;

    let candidates: ListedCandidate[] = [];
    let failure: string | null = null;

    if (source !== undefined) {
      try {
        const answer = await this.deps.sendRequest('sources.list', {
          source: source.id,
          ...(scope === null ? {} : { scope }),
          ...this.buildPathTargetParam(),
        });

        candidates = parseCandidates(answer['candidates']);
      } catch (error) {
        failure = formatError(error);
      }
    }

    if (this.isStale(generation) || this.pathListingSeq !== seq) {
      this.deps.onDropAnswer?.('directory listing');

      return;
    }

    this.pathListingSeq = null;

    const listed = candidates.flatMap((candidate) =>
      candidate.pick.kind === 'path' ? [[candidate.pick.directory, candidate.label] as const] : [],
    );

    this.sourceIndex = index;

    // A git listing dropped here never fills its candidates, so its source
    // step lists again when it reopens.
    if (this.listingSeq !== null) {
      this.listingSeq = null;
      this.listedKey = null;
    }

    this.dirLabels = new Map(listed);

    const own = this.deps.remoteDaemon === true ? [] : [this.deps.cwd];

    this.dirs = [...new Set([...own, ...listed.map(([directory]) => directory)])];
    this.input = '';
    this.selected = 0;
    this.step = 'dir';

    // A failed listing is no empty one, so the step shows why until the
    // next key.
    if (failure !== null) {
      this.deps.log?.(`directory listing failed: ${failure}`);
      this.refusal = `cannot list directories: ${failure}`;
    }

    this.deps.write(ansi.clear);
    this.render();
  }

  // The target a remote daemon checks a directory request against: the
  // chosen one, else the default the caller may use, else the first, since
  // a principal may hold no default target. A local request sends none.
  private buildPathTargetParam(): Readonly<Record<string, string>> {
    if (this.deps.remoteDaemon !== true) {
      return {};
    }

    const eligible = this.collectEligibleTargets();
    const target = this.target ?? eligible.find((candidate) => candidate.isDefault) ?? eligible[0];

    return target === undefined ? {} : { target: target.id };
  }

  // The client's directory, which a typed relative path reads from when the
  // daemon runs on the client's machine; a remote daemon gets none.
  private buildClientCwdParam(): Readonly<Record<string, string>> {
    return this.deps.remoteDaemon === true ? {} : { clientCwd: this.deps.cwd };
  }

  // the target step comes first when there is one and no repository target is chosen yet,
  // so every request about the repository goes to the target the spawn runs on.
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

    if (this.openTargetStep()) {
      this.deps.write(ansi.clear);
      this.render();

      return;
    }

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
      this.listedFrom = null;
      this.refreshFailure = null;
    }

    // A scope a reading asked for is listed in place of the source's own
    // default, for the target the step now has. A listing the cache keeps
    // shows at once, and the listing behind the step replaces it.
    const scope = action.kind === 'browse' ? action.scope : null;

    if (action.kind === 'browse' || stale) {
      this.restoreCachedCandidates(scope);
    }

    this.deps.write(ansi.clear);
    this.render();

    if (action.kind === 'browse' || stale) {
      void this.loadCandidates(scope);
    }

    if (action.kind === 'probe') {
      void this.checkRepoAccess(this.sourceDraft, action.url);
    }
  }

  // Shows the listing the cache keeps for a scope on this source and
  // target, if any. Without one, the step keeps what it shows.
  private restoreCachedCandidates(scope: string | null) {
    const source = this.findSource();
    const cache = this.deps.listingCache;

    this.listedFrom = null;
    this.refreshFailure = null;

    if (source === null || cache === undefined) {
      return;
    }

    const cached = cache.readListing(this.buildListingKey(source.id, scope), this.getNow());

    // A source that lists nothing, such as a typed git URL, has nothing
    // to show from the cache.
    if (cached === null || (cached.candidates.length === 0 && cached.scope === null)) {
      return;
    }

    this.candidates = parseCandidates(cached.candidates);
    this.listedScope = cached.scope;
    this.listedFrom = cached.listedAt;

    this.listNotice =
      this.candidates.length === 0 && this.listedScope !== null
        ? `nothing listed for ${this.listedScope}`
        : null;
  }

  // Lists the git source step's scope again behind the step, keeping what
  // it shows until the answer comes.
  private refreshCandidates() {
    this.listedKey = `${this.findSource()?.id ?? ''}\n${this.target?.id ?? ''}`;
    void this.loadCandidates(this.requestedScope);
  }

  // The key a listing is kept under in the listing cache: the daemon, the
  // source, the target, and the scope.
  private buildListingKey(sourceID: string, scope: string | null): string {
    return [
      this.deps.getDaemonSocketPath?.() ?? '',
      sourceID,
      this.target?.id ?? '',
      scope ?? '',
    ].join('\n');
  }

  private getNow(): number {
    return this.deps.clock.now();
  }

  // The target every source request is made for: the chosen one, or none
  // for the daemon's default when there is no choice to make.
  private buildTargetParam(): Readonly<Record<string, string>> {
    return this.target === null ? {} : { target: this.target.id };
  }

  // a daemon that cannot list leaves a notice row, or the cached listing with the failure in
  // its hint. Typing goes on meanwhile, and Esc stops a listing the step shows nothing for.
  private async loadCandidates(scope: string | null) {
    const source = this.findSource();
    const generation = this.generation;

    if (source === null) {
      return;
    }

    this.requestSeq += 1;

    const seq = this.requestSeq;
    const key = this.buildListingKey(source.id, scope);
    const requestedAt = this.getNow();

    this.listingSeq = seq;
    this.requestedScope = scope;

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

    // a late answer still holds what the daemon lists, so the cache keeps it. An empty one
    // replaces a kept list too, so a repository the daemon no longer lists never comes back
    // from the cache.
    if (answer !== null && Array.isArray(answer['candidates'])) {
      void this.deps.listingCache?.writeListing(key, {
        candidates: answer['candidates'],
        scope: typeof answer['scope'] === 'string' ? answer['scope'] : scope,
        listedAt: requestedAt,
      });
    }

    if (this.isStale(generation) || this.listingSeq !== seq) {
      this.deps.onDropAnswer?.('listing');

      return;
    }

    // An answer for a source the flow has left fills nothing, so that
    // source lists again when its step reopens.
    if (this.findSource()?.id !== source.id) {
      this.listingSeq = null;
      this.listedKey = null;
      this.deps.onDropAnswer?.('listing');

      return;
    }

    this.listingSeq = null;

    // The row the source step has selected, which stays selected when the
    // fresh listing still holds it.
    const chosen = this.collectCandidateItems()[this.selected]?.candidate?.label;

    if (answer === null && this.listedFrom !== null) {
      this.refreshFailure = formatListFailure(failure);
    } else if (answer === null) {
      this.candidates = [];
      this.listedScope = scope;
      this.listNotice = `${formatListFailure(failure)} — type to enter one`;
    } else {
      this.candidates = parseCandidates(answer['candidates']);
      this.listedScope = typeof answer['scope'] === 'string' ? answer['scope'] : scope;
      this.listedFrom = null;
      this.refreshFailure = null;

      this.listNotice =
        this.candidates.length === 0 && this.listedScope !== null
          ? `nothing listed for ${this.listedScope}`
          : null;
    }

    // The list answers behind the flow, so only the source step's own
    // selection moves: to the row it had, else to the first.
    if (this.step === 'source') {
      this.selected = Math.max(
        0,
        this.collectCandidateItems().findIndex((item) => item.candidate?.label === chosen),
      );

      this.deps.write(ansi.clear);
      this.render();

      return;
    }

    this.deps.log?.(`kept the ${this.step} step through a listing answer`);
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

      if (reading.kind !== 'refused' && canTakeReading('git', reading)) {
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
  // asked, and moves the flow to the first whose kind takes the reading.
  // Text none reads is refused, with each refusal the daemon gave.
  private async readTypedInput(typed: string, withOwn: boolean) {
    const order = this.sources.flatMap((_, index) => (index === this.sourceIndex ? [] : [index]));
    const failures: string[] = [];

    for (const index of withOwn ? [this.sourceIndex, ...order] : order) {
      const reading = await this.sendInterpret(index, typed);

      if (reading === null) {
        return;
      }

      if (reading.kind === 'refused') {
        failures.push(reading.reason);
      } else if (canTakeReading(this.sources[index]?.kind, reading)) {
        this.applyReading(index, reading, typed);

        return;
      }
    }

    this.refusal =
      failures.length === 0
        ? `no source reads ${typed} · esc back`
        : `cannot read ${typed}: ${failures.join(' · ')} · esc back`;

    this.deps.write(ansi.clear);
    this.render();
  }

  // Asks one source what typed text is. Null when Esc cancelled the
  // request.
  private async sendInterpret(
    index: number,
    typed: string,
  ): Promise<SourceInterpretation | { readonly kind: 'refused'; readonly reason: string } | null> {
    const source = this.sources[index];

    if (source === undefined) {
      return { kind: 'none' };
    }

    const answered = await this.sendPending('interpret', `reading ${typed}…`, 'sources.interpret', {
      source: source.id,
      input: typed,
      ...(source.kind === 'git'
        ? this.buildTargetParam()
        : { ...this.buildPathTargetParam(), ...this.buildClientCwdParam() }),
    });

    if (answered === null) {
      return null;
    }

    return answered.ok
      ? parseInterpretation(answered.answer)
      : { kind: 'refused', reason: formatError(answered.error) };
  }

  // Moves the flow to what a source read typed text as: its scope listed,
  // the directory chosen, or the repository probed.
  private applyReading(index: number, reading: SourceInterpretation, typed: string) {
    if (reading.kind === 'none') {
      return;
    }

    if (reading.kind === 'path') {
      this.sourceIndex = index;

      this.applyDir(reading.directory);

      return;
    }

    const scope = reading.kind === 'browse' ? reading.scope : null;

    if (this.sources[index]?.kind === 'path') {
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

    // A scope the cache keeps shows at once, while the step lists it again.
    if (reading.kind === 'browse') {
      this.input = '';
      this.selected = 0;

      this.restoreCachedCandidates(reading.scope);
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
    method: string,
    params: Readonly<Record<string, unknown>>,
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
      result = { ok: true, answer: await this.deps.sendRequest(method, params) };
    } catch (error) {
      result = { ok: false, error };
    }

    if (this.isStale(generation) || this.pending?.seq !== seq) {
      this.deps.onDropAnswer?.(kind);

      return null;
    }

    this.pending = null;

    return result;
  }

  // a failure stays on the source step with git's error and offers the other URL form the
  // daemon returns, when there is one.
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

      this.deps.write(ansi.clear);
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
    this.deps.write(ansi.clear);
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

    this.deps.write(ansi.clear);
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

    if (COMMIT_ID_PATTERN.test(typed)) {
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

    this.deps.write(ansi.clear);
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
    this.deps.write(ansi.clear);
    this.render();
  }

  // Opens the confirm screen with the destination the user last accepted,
  // else the default under the target's workspace root. A root the target
  // cannot take leaves the destination empty with the reason.
  private openConfirmStep() {
    this.step = 'confirm';
    this.destinationAttempt = 1;
    this.autoDestination = null;

    if (this.destination === '' && this.repo !== null && this.ref !== null) {
      const target = this.findEffectiveTarget();

      const root = resolveWorkspaceRoot(this.workspaces, {
        id: target?.id ?? LOCAL_TARGET.id,
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
      } else if (target !== null && !target.inPlace && this.canPickOnTarget(target.id)) {
        this.autoDestination = buildWorkspaceDestination({
          root: this.workspaces.targetRoots.get(target.id) ?? this.workspaces.root ?? AUTO_ROOT,
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

  // Whether the daemon picks the destination on a remote target: the
  // target's configured root, if any, must be one it resolves there, under
  // the home.
  private canPickOnTarget(target: string): boolean {
    const configured = this.workspaces.targetRoots.get(target) ?? this.workspaces.root;

    return configured === null || isHomeRelative(configured);
  }

  // Takes the confirm screen's destination: absolute on its target, with a
  // leading `~` expanded only on the daemon's own machine. False, with the
  // reason shown, when the target cannot take it.
  private applyDestination(typed: string): boolean {
    // An empty destination takes the one the daemon picks on the target.
    if (typed === '' && this.autoDestination !== null) {
      this.destinationRepoURL = this.repo?.url ?? null;
      this.directory = '';

      return true;
    }

    const inPlace = this.findEffectiveTarget()?.inPlace ?? true;
    const directory = inPlace ? expandHome(typed, this.deps.home) : typed;

    if (!directory.startsWith('/')) {
      this.refusal = inPlace
        ? 'the destination must be an absolute path'
        : 'the destination must be an absolute path on the target; ~ is not expanded there';

      return false;
    }

    if (directory !== this.buildDestination()) {
      this.destination = directory;
      this.destinationAttempt = 1;
      this.destinationEdited = true;
    }

    this.autoDestination = null;
    this.destinationRepoURL = this.repo?.url ?? null;
    this.directory = this.buildDestination();

    return true;
  }

  // The destination with the suffix a refused spawn added.
  private buildDestination(): string {
    return this.destinationAttempt === 1
      ? this.destination
      : `${this.destination}-${this.destinationAttempt}`;
  }

  private formatDestination(): string {
    const target = this.findEffectiveTarget()?.id ?? LOCAL_TARGET.id;

    return this.autoDestination === null
      ? `${target}:${this.buildDestination()}`
      : `${target}:${this.autoDestination}`;
  }

  // The target the spawn runs on: the chosen one, else the daemon's
  // default, else null when the daemon lists no targets.
  private findEffectiveTarget(): TargetPick | null {
    return this.target ?? this.targets.find((target) => target.isDefault) ?? null;
  }

  // opens only when more than one target can run the source, or none can although the
  // daemon lists targets, and answers whether it did.
  private openTargetStep(): boolean {
    const eligible = this.collectEligibleTargets();

    if (eligible.length === 1 || (this.targets.length === 0 && this.targetGap === null)) {
      // the spawn names the one usable target, default or not, so its provider decides whether
      // a directory runs in place. A daemon that lists no targets runs the spawn on its default.
      this.target = eligible[0] ?? null;

      return false;
    }

    const preferred =
      this.target ??
      (this.isGitFlow()
        ? (this.targets.find((target) => target.isDefault && target.takesWorkspace) ??
          this.targets.find((target) => target.takesWorkspace))
        : undefined) ??
      this.targets.find((target) => target.isDefault);

    this.selected = Math.max(
      0,
      this.targets.findIndex((target) => target.id === preferred?.id),
    );

    this.input = '';
    this.step = 'target';

    return true;
  }

  // The targets the flow's source can run on.
  private collectEligibleTargets(): TargetPick[] {
    const git = this.isGitFlow();

    return this.targets.filter((target) => findTargetRefusal(target, git) === null);
  }

  // Reads the daemon's targets and sources once the agent is chosen, and
  // opens the first source, or the first of directories for an adopt. With
  // none to open, the agent step shows why.
  private async openFirstSource() {
    const generation = this.generation;
    let listed: Readonly<Record<string, unknown>> = {};

    this.sourcesPending = true;

    this.render();

    try {
      listed = await this.deps.sendRequest('agents.list');
    } catch {}

    if (this.isStale(generation)) {
      this.deps.onDropAnswer?.('targets and sources');

      return;
    }

    // An agent that starts only behind impd's broker runs only on a target
    // that reaches the broker.
    const brokered = isBrokerAgent(listed['agents'], this.agent);
    const listedTargets = collectTargetPicks(listed);
    const picks = listedTargets.filter((target) => !brokered || target.brokerAuth);

    // An adopt resumes a session from its history on this host, which a
    // fresh checkout elsewhere does not hold, so it is offered only the
    // targets that run here.
    this.targets = this.resume
      ? picks.filter((target) => target.available && target.inPlace)
      : picks;

    this.targetGap = null;

    if (listedTargets.length > 0 && picks.length === 0) {
      this.targetGap = `no target reaches the credential broker ${this.agent} needs`;
    } else if (listedTargets.length > 0 && this.targets.length === 0) {
      this.targetGap = 'no target on this host can adopt a session';
    }

    const announced = parseAnnouncedSources(listed['sources']);
    const index = this.resume ? announced.findIndex((source) => source.kind === 'path') : 0;

    this.sources = announced;

    if (announced.length > 0 && index !== -1) {
      this.openSource(index);

      return;
    }

    this.sourcesPending = false;

    this.refusal =
      announced.length === 0
        ? 'the daemon offers no sources · set workspaces.sources · esc cancel'
        : 'no directory source to adopt in · set workspaces.sources · esc cancel';

    this.render();
  }

  private async spawn(prompt: string) {
    const params = {
      ...(this.isGitFlow() && this.autoDestination !== null ? {} : { cwd: this.directory }),
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

    const warnings = spawned.answer['warnings'];

    // A workspace that left changes behind says so before the session's
    // screen takes over.
    if (Array.isArray(warnings) && warnings.length > 0) {
      this.spawned = session;

      this.spawnedWarnings = warnings.filter(
        (warning): warning is string => typeof warning === 'string',
      );

      this.step = 'spawned';

      this.deps.write(ansi.clear);
      this.render();

      return;
    }

    await this.deps.attach(session.id);
  }

  // The started step takes Enter to attach the session and Esc or the
  // leader to return to the screen the flow came from; the session runs
  // either way.
  private applySpawnedKey(buf: Buffer) {
    const edit = planTextEdit(buf, '', { isLeaderKey: this.deps.isLeaderKey, moves: false });

    if (edit.kind !== 'submit' && edit.kind !== 'cancel' && edit.kind !== 'leader') {
      return;
    }

    const session = this.spawned;

    this.spawned = null;
    this.spawnedWarnings = [];
    this.step = 'agent';

    if (edit.kind === 'submit' && session !== null) {
      void this.deps.attach(session.id);

      return;
    }

    this.deps.showBase();
  }

  // a refused git workspace spawn returns to the step that can fix it; any other refusal
  // stays on the step that sent it with the entered text back, so the user can fix the
  // cause and retry or back out.
  private applySpawnRefusal(error: unknown, prompt: string) {
    const reason = formatError(error);
    const code = error instanceof DaemonError ? error.code : 'internal';
    const step = this.isGitFlow() ? pickRefusalStep(code) : null;

    if (step === 'ref') {
      void this.refreshRefs(reason);

      return;
    }

    if (step === 'destination' && this.autoDestination !== null) {
      // The daemon already tried the numbered directories beside its pick.
      this.step = 'confirm';
      this.input = '';
      this.refusal = `${reason} · esc back`;
    } else if (step === 'destination') {
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

    this.deps.write(ansi.clear);
    this.render();
  }

  // a repository goes at the commit the confirm screen showed. A local directory runs in
  // place on a target on the daemon's own machine, and on any other is materialized at the
  // same path from its pushed HEAD.
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

    return { ...target, workspace: { kind: 'path', path: this.directory } };
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
  kind: SourceEntry['kind'] | undefined,
  reading: SourceInterpretation,
): boolean {
  return reading.kind === 'browse' || (reading.kind !== 'none' && reading.kind === kind);
}

function formatRef(ref: GitRef, head: string | null): string {
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
// How old a cached listing is, in whole minutes or hours.
function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);

  if (minutes < 1) {
    return 'under 1m';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h`;
}

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

// Whether the daemon lists an agent as starting only behind impd's broker.
function isBrokerAgent(raw: unknown, agent: AgentID): boolean {
  return (
    Array.isArray(raw) &&
    raw.some(
      (entry: unknown) =>
        isRecord(entry) && entry['id'] === agent && entry['brokerRequired'] === true,
    )
  );
}

function parseAnnouncedSources(raw: unknown): SourceEntry[] {
  return collectParsed(raw, (entry) => SOURCE_ENTRY_SCHEMA.safeParse(entry).data);
}

function parseCandidates(raw: unknown): ListedCandidate[] {
  return collectParsed(raw, (entry) => {
    const candidate = SOURCE_CANDIDATE_SCHEMA.safeParse(entry).data;

    return candidate === undefined
      ? undefined
      : { label: candidate.label, detail: candidate.detail ?? null, pick: candidate.pick };
  });
}

function parseInterpretation(answer: Readonly<Record<string, unknown>>): SourceInterpretation {
  return SOURCE_INTERPRETATION_SCHEMA.safeParse(answer).data ?? { kind: 'none' };
}

function parseProbedRefs(raw: unknown): GitRef[] {
  return collectParsed(raw, (entry) => GIT_REF_SCHEMA.safeParse(entry).data);
}

// The entries of an answer's list that parse, in order, leaving out each
// one that does not; a value that is no list has none.
function collectParsed<T>(raw: unknown, parse: (entry: unknown) => T | undefined): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry: unknown) => {
    const parsed = parse(entry);

    return parsed === undefined ? [] : [parsed];
  });
}
