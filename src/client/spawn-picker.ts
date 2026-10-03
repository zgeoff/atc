import { homedir } from 'node:os';
import type { AgentID } from '../agents/agent-adapter';
import { DaemonError } from '../protocol/daemon-error';
import type { WorkspacesConfig } from '../shared/collect-workspaces-config';
import { loadConfig } from '../shared/config';
import { isRecord } from '../shared/report';
import { resolveHomeDir } from '../shared/resolve-home-dir';
import { buildWorkspaceDestination } from './build-workspace-destination';
import { collectAgentPicks } from './collect-agent-picks';
import type { AgentPick } from './collect-agent-picks';
import { collectPathCompletions } from './collect-path-completions';
import { collectTargetPicks } from './collect-target-picks';
import type { TargetPick } from './collect-target-picks';
import { collectZoxideDirs } from './collect-zoxide-dirs';
import { collectDirs, formatDir, formatDirName, pickMatches } from './dirs';
import { findAlternateGitURL } from './find-alternate-git-url';
import { KEY, planTextEdit } from './keys';
import { parseRepoInput } from './parse-repo-input';
import { pickRefusalStep } from './pick-refusal-step';
import { resolvePathInput } from './resolve-path-input';
import { resolveWorkspaceRoot } from './resolve-workspace-root';
import { ansi, cols, drawPicker } from './ui';

type PickerStep = 'agent' | 'dir' | 'repo' | 'ref' | 'target' | 'confirm' | 'name' | 'prompt';

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

// One repository `repos.list` returned.
interface ListedRepo {
  readonly nameWithOwner: string;
  readonly description: string;
  readonly isPrivate: boolean;
  readonly url: string;
  readonly sshUrl: string;
}

// One branch or tag `repos.probe` returned.
interface ProbedRef {
  readonly name: string;
  readonly kind: 'branch' | 'tag';
  readonly sha: string;
}

// The repository the probe proved the daemon's host can read.
interface ProbedRepo {
  // What the user chose, shown as the repository step's input on the way
  // back to it.
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

/**
 * The modal flow behind n and r: agent, then source, then execution target
 * when the daemon has more than one, then name, then an optional first
 * prompt. The source is a local directory, or, after Tab in a spawn, a git
 * repository: the repository, then its ref, then a confirm screen with the
 * destination the checkout lands in. Every path out of the flow either
 * attaches the new session or returns the client to the screen it came
 * from. A spawn the daemon refuses is no path out: the flow returns to the
 * step that can fix the cause and shows why.
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

  // The configured roots and workspace settings, read with the agents each
  // time the menu opens.
  private roots: readonly string[] = [];

  private workspaces: WorkspacesConfig = { githubOwner: null, root: null, targetRoots: new Map() };

  private dir = '';

  // The daemon's execution targets, read when the directory step opens,
  // and the one chosen; null spawns on the daemon's default target.
  private targets: TargetPick[] = [];

  private target: TargetPick | null = null;

  // The listed repositories and whose they are, or the notice that stands
  // in for a list the daemon could not give; read once per open, and again
  // for each `owner/` asked for.
  private repos: ListedRepo[] = [];

  private reposOwner: string | null = null;

  private reposNotice: string | null = null;

  private reposListed = false;

  private gitProtocol: 'https' | 'ssh' = 'https';

  // The other URL form of a repository whose probe failed, offered as the
  // repository step's one item until the input changes.
  private alternateURL: string | null = null;

  private repo: ProbedRepo | null = null;

  private ref: ChosenRef | null = null;

  // The destination the user accepted on the confirm screen, before any
  // suffix a refused spawn adds, and that suffix's number.
  private destination = '';

  private destinationAttempt = 1;

  private name = '';

  private resume = false;

  private agent: AgentID = 'claude';

  // Why the last action was refused, shown in place of the hint until the
  // next key.
  private refusal: string | null = null;

  // What an in-flight request is doing, shown in place of the hint.
  private pending: string | null = null;

  constructor(deps: SpawnPickerDeps<TMirror>) {
    this.deps = deps;
  }

  open(resume = false) {
    this.resume = resume;

    const config = loadConfig();

    this.picks = collectAgentPicks(config);
    this.roots = config.dirs.roots;
    this.workspaces = config.workspaces;
    this.input = '';
    this.target = null;
    this.repo = null;
    this.ref = null;
    this.reposListed = false;
    this.alternateURL = null;

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
    // A request in flight owns the step until it answers.
    if (this.pending !== null) {
      return;
    }

    this.refusal = null;

    // Tab switches the source of a spawn between a local directory and a
    // git repository. Adopt resumes a session in a directory that already
    // holds one, so it stays local.
    if (buf.length === 1 && buf[0] === KEY.tab) {
      if (!this.resume && (this.step === 'dir' || this.step === 'repo')) {
        const other = this.step === 'dir' ? 'repo' : 'dir';

        this.openSourceStep(other, '');
      }

      return;
    }

    const edit = planTextEdit(buf, this.input, {
      isLeaderKey: this.deps.isLeaderKey,
      moves:
        this.step === 'agent' ||
        this.step === 'dir' ||
        this.step === 'repo' ||
        this.step === 'ref' ||
        this.step === 'target',
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
      const items = this.collectDirItems().map((d) => formatDir(d));

      this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

      drawPicker({
        title: `${verb}: directory`,
        items,
        selected: this.selected,
        input: this.input,
        hint: `type to filter, or a path (/ ~ .) · ↑↓ move · ⏎ select${this.resume ? '' : ' · tab github'} · esc cancel`,
      });
    } else if (this.step === 'repo') {
      this.renderRepoStep();
    } else if (this.step === 'ref') {
      this.renderRefStep();
    } else if (this.step === 'target') {
      this.selected = Math.min(this.selected, this.targets.length - 1);

      const github = this.repo !== null;

      drawPicker({
        title: `${verb}: target`,
        items: this.targets.map((t) => formatTargetPick(t)),
        selected: this.selected,
        input: '',
        hint:
          this.refusal ??
          `where ${github ? this.repo?.label : formatDir(this.dir)} runs · ↑↓ move · ⏎ select · esc back`,
        dimmed: new Set(
          this.targets.flatMap((t, i) =>
            t.takesWorkspace || (!github && t.available && t.inPlace) ? [] : [i],
          ),
        ),
      });
    } else if (this.step === 'confirm') {
      this.renderConfirmStep();
    } else if (this.step === 'name') {
      const where = this.repo === null ? formatDir(this.dir) : this.formatDestination();

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
        hint: this.pending ?? this.refusal ?? 'first message for the session · ⏎ spawn · esc back',
      });
    }

    this.deps.scheduleStatus();
  }

  private renderRepoStep() {
    const items = this.collectRepoItems();

    this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

    const owner = this.reposOwner === null ? '' : ` · ${this.reposOwner}`;

    drawPicker({
      title: `spawn: repository${owner}`,
      items: items.map((item) => item.label),
      selected: items.length === 0 || items[0]?.notice === true ? -1 : this.selected,
      input: this.input,
      hint:
        this.pending ??
        this.refusal ??
        'owner/repo, a git URL, or owner/ to list · ↑↓ move · ⏎ select · tab local · esc back',
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
        this.pending ??
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

  private applyInput(value: string) {
    // The target step takes no text: its list is short and fixed.
    if (this.step === 'target') {
      return;
    }

    this.input = value;

    if (this.step === 'repo') {
      this.alternateURL = null;
    }

    // A pasted URL in the directory step is a repository, not a path.
    if (
      this.step === 'dir' &&
      !this.resume &&
      parseRepoInput(value).kind === 'url' &&
      !value.startsWith('/')
    ) {
      this.openSourceStep('repo', value);

      return;
    }

    this.render();
  }

  private applyCancel() {
    if (this.step === 'agent') {
      this.deps.toBase();

      return;
    }

    this.input = '';

    if (this.step === 'dir' || this.step === 'repo') {
      this.selected = Math.max(
        0,
        this.picks.findIndex((p) => p.agent === this.agent),
      );

      this.step = 'agent';
    } else if (this.step === 'ref') {
      this.input = this.repo?.label ?? '';
      this.repo = null;
      this.step = 'repo';
    } else if (this.step === 'target') {
      if (this.repo === null) {
        this.step = 'dir';
      } else {
        this.openRefStep();
      }
    } else if (this.step === 'confirm') {
      this.openTargetOr(() => {
        this.openRefStep();
      });
    } else if (this.step === 'name') {
      if (this.repo === null) {
        this.openTargetOr(() => {
          this.step = 'dir';
        });
      } else {
        this.input = this.buildDestination();
        this.step = 'confirm';
      }
    } else {
      this.input = this.name;
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

    if (this.step === 'repo') {
      void this.applyRepoSubmit();

      return;
    }

    if (this.step === 'ref') {
      void this.applyRefSubmit();

      return;
    }

    if (this.step === 'dir') {
      const items = this.collectDirItems();
      const typed = parseRepoInput(this.input);

      // A typed `owner/repo` that matches no directory is a repository.
      if (!this.resume && items.length === 0 && typed.kind === 'repo') {
        this.openSourceStep('repo', this.input, false);
        void this.applyRepoSubmit();

        return;
      }

      const chosen =
        items[this.selected] ?? resolvePathInput(this.input.trim(), process.cwd(), homedir());

      if (chosen === null) {
        return;
      }

      this.dir = chosen;
      this.input = '';

      this.openTargetOr(() => {
        this.step = 'name';
      });
    } else if (this.step === 'target') {
      const pick = this.targets[this.selected];

      if (pick === undefined) {
        return;
      }

      const refusal = findTargetRefusal(pick, this.repo !== null);

      if (refusal !== null) {
        this.refusal = refusal;

        this.render();

        return;
      }

      this.target = pick;
      this.input = '';

      if (this.repo === null) {
        this.step = 'name';
      } else {
        this.openConfirmStep();
      }
    } else if (this.step === 'confirm') {
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

  /**
   * A typed path completes against the filesystem, like a shell; anything
   * else fuzzy-filters the merged list.
   */
  private collectDirItems(): string[] {
    return resolvePathInput(this.input, process.cwd(), homedir()) === null
      ? pickMatches(this.dirs, this.input)
      : collectPathCompletions(this.input, process.cwd(), homedir());
  }

  // The repository step's rows: the other URL form after a failed probe,
  // the notice in place of a list the daemon could not give, or the listed
  // repositories the input matches.
  private collectRepoItems(): {
    label: string;
    notice?: boolean;
    repo?: ListedRepo;
    url?: string;
  }[] {
    if (this.alternateURL !== null) {
      return [{ label: `try ${this.alternateURL} instead`, url: this.alternateURL }];
    }

    if (this.reposNotice !== null) {
      return [{ label: this.reposNotice, notice: true }];
    }

    const typed = parseRepoInput(this.input);
    const filter = typed.kind === 'filter' ? typed.text : '';

    const byName = new Map(this.repos.map((repo) => [repo.nameWithOwner, repo]));

    return pickMatches([...byName.keys()], filter).flatMap((name) => {
      const repo = byName.get(name);

      if (repo === undefined) {
        return [];
      }

      const notes = [
        ...(repo.isPrivate ? ['private'] : []),
        ...(repo.description === '' ? [] : [repo.description]),
      ];

      return [{ label: notes.length === 0 ? name : `${name}  ${notes.join(' · ')}`, repo }];
    });
  }

  // The ref step's rows: the default branch first, then every branch and
  // tag in the order the upstream lists them, filtered by the input.
  private collectRefItems(): ProbedRef[] {
    const refs = this.repo?.refs ?? [];
    const head = this.repo?.head ?? null;

    const ordered = [
      ...refs.filter((ref) => ref.kind === 'branch' && ref.name === head),
      ...refs.filter((ref) => !(ref.kind === 'branch' && ref.name === head)),
    ];

    const names = pickMatches(
      ordered.map((ref) => `${ref.kind}:${ref.name}`),
      this.input.trim(),
    );

    return names.flatMap((key) => ordered.filter((ref) => `${ref.kind}:${ref.name}` === key));
  }

  // Switches the source step, carrying the typed text across and reading
  // the repository list the first time the repository step opens.
  private openSourceStep(step: 'dir' | 'repo', input: string, list = true) {
    this.step = step;
    this.input = input;
    this.selected = 0;
    this.alternateURL = null;

    process.stdout.write(ansi.clear);
    this.render();

    if (step === 'repo' && list && !this.reposListed) {
      this.reposListed = true;
      void this.loadRepos(this.workspaces.githubOwner);
    }
  }

  // Reads one owner's repositories from the daemon; null reads its default
  // owner's. A daemon that cannot list them leaves a notice row, and typed
  // input still works.
  private async loadRepos(owner: string | null) {
    this.pending = 'listing repositories…';

    this.render();

    try {
      const params = owner === null ? {} : { owner };

      const answer = await this.deps.sendRequest('repos.list', params);

      this.repos = parseListedRepos(answer['repos']);
      this.reposOwner = typeof answer['owner'] === 'string' ? answer['owner'] : owner;
      this.gitProtocol = answer['gitProtocol'] === 'ssh' ? 'ssh' : 'https';

      this.reposNotice =
        this.repos.length === 0
          ? `no repositories listed for ${this.reposOwner ?? 'this account'}`
          : null;
    } catch (error) {
      this.repos = [];
      this.reposOwner = owner;
      this.reposNotice = `${formatListFailure(error)} — type owner/repo or a git URL`;
    }

    this.pending = null;
    this.selected = 0;

    if (this.step === 'repo') {
      process.stdout.write(ansi.clear);
      this.render();
    }
  }

  private async applyRepoSubmit() {
    const items = this.collectRepoItems();
    const typed = parseRepoInput(this.input);
    const item = items[this.selected];

    if (typed.kind === 'owner') {
      this.input = '';

      await this.loadRepos(typed.owner);

      return;
    }

    if (item?.url !== undefined) {
      await this.checkRepoAccess(item.url, item.url);

      return;
    }

    if (typed.kind === 'url') {
      await this.checkRepoAccess(typed.url, typed.url);

      return;
    }

    const listed =
      typed.kind === 'repo'
        ? this.repos.find((repo) => repo.nameWithOwner === typed.nameWithOwner)
        : item?.repo;

    if (listed !== undefined) {
      // gh's preferred protocol picks the URL form; the probe proves it.
      const url = this.gitProtocol === 'ssh' ? listed.sshUrl : listed.nameWithOwner;

      await this.checkRepoAccess(listed.nameWithOwner, url);
    } else if (typed.kind === 'repo') {
      await this.checkRepoAccess(typed.nameWithOwner, typed.nameWithOwner);
    }
  }

  // Checks that the daemon's host can read the repository at this URL, and
  // opens the ref step with its refs. A failure stays on the repository
  // step with git's error and offers the other URL form when there is one.
  private async checkRepoAccess(label: string, url: string) {
    this.pending = `checking access to ${url}…`;

    this.render();

    let answer: Readonly<Record<string, unknown>>;

    try {
      answer = await this.deps.sendRequest('repos.probe', { url });
    } catch (error) {
      this.pending = null;
      this.alternateURL = findAlternateGitURL(url);
      this.selected = 0;
      this.refusal = `${formatError(error)} · esc back`;
      this.input = label;

      process.stdout.write(ansi.clear);
      this.render();

      return;
    }

    this.pending = null;

    this.repo = {
      label,
      url: typeof answer['url'] === 'string' ? answer['url'] : url,
      head: typeof answer['head'] === 'string' ? answer['head'] : null,
      refs: parseProbedRefs(answer['refs']),
    };

    this.ref = null;

    this.openRefStep();
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
    this.pending = `resolving ${typed}…`;

    this.render();

    try {
      const answer = await this.deps.sendRequest('repos.probe', { url: this.repo.url, ref: typed });

      const resolved = isRecord(answer['resolved']) ? answer['resolved'] : {};

      this.pending = null;

      if (typeof resolved['sha'] === 'string') {
        this.applyRef({ ref: typed, sha: resolved['sha'] });

        return;
      }

      this.refusal = `the daemon resolved no commit for ${typed} · esc back`;
    } catch (error) {
      this.pending = null;
      this.refusal = `${formatError(error)} · esc back`;
    }

    process.stdout.write(ansi.clear);
    this.render();
  }

  private applyRef(ref: ChosenRef) {
    this.ref = ref;
    this.input = '';
    this.destination = '';

    this.openTargetOr(() => {
      this.openConfirmStep();
    });

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
    }

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

  // Opens the target step when the daemon has more than one target, with
  // the chosen or default target selected, and the fallback step otherwise.
  private openTargetOr(fallback: () => void) {
    if (this.targets.length < 2) {
      this.target = null;

      fallback();

      return;
    }

    const preferred = this.target?.id;

    this.selected = Math.max(
      0,
      this.targets.findIndex((t) => (preferred === undefined ? t.isDefault : t.id === preferred)),
    );

    this.input = '';
    this.step = 'target';
  }

  private async openDirStep() {
    let recent: string[] = [];

    try {
      const listed = await this.deps.sendRequest('agents.list');

      const picks = collectTargetPicks(listed);

      // An adopt resumes a session from its history on this host, which a
      // fresh checkout elsewhere does not hold, so it is offered only the
      // targets that run here.
      this.targets = this.resume ? picks.filter((t) => t.available && t.inPlace) : picks;
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
    this.repo = null;

    process.stdout.write(ansi.clear);
    this.render();
  }

  private async spawn(prompt: string) {
    if (this.repo !== null) {
      this.pending = 'materializing the workspace…';

      this.render();
    }

    try {
      const ok = await this.deps.sendRequest('session.spawn', {
        cwd: this.dir,
        name: this.name,
        prompt,
        cols: cols(),
        rows: this.deps.ptyRows(),
        ...(this.resume ? { resume: true } : {}),
        agent: this.agent,
        ...this.buildSourceParams(),
      });

      this.pending = null;

      const spawned = this.deps.toMirrorSession(ok['session']);

      if (spawned !== null) {
        this.deps.upsertMirror(spawned);

        await this.deps.attach(spawned.id);

        return;
      }
    } catch (error) {
      this.pending = null;

      this.applySpawnRefusal(error, prompt);

      return;
    }

    this.deps.toBase();
  }

  // A refused git workspace spawn returns to the step that can fix it. Any
  // other refusal keeps the picker on the step that sent it, with the
  // entered text back in the input, so the user can fix the cause and retry
  // or back out.
  private applySpawnRefusal(error: unknown, prompt: string) {
    const reason = formatError(error);
    const code = error instanceof DaemonError ? error.code : 'internal';
    const step = this.repo === null ? null : pickRefusalStep(code);

    if (step === 'destination') {
      this.destinationAttempt += 1;
      this.step = 'confirm';
      this.input = this.buildDestination();
      this.refusal = `${reason} · ⏎ use ${this.buildDestination()} · esc back`;
    } else if (step === 'ref') {
      this.openRefStep();

      this.refusal = `${reason} · esc back`;
    } else if (step === 'repo') {
      this.input = this.repo?.label ?? '';
      this.repo = null;
      this.step = 'repo';
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
  // in place on a target on the daemon's own machine, and is materialized
  // at the same path from its pushed HEAD on any other.
  private buildSourceParams(): Readonly<Record<string, unknown>> {
    const target = this.target === null ? {} : { target: this.target.id };

    if (this.repo !== null && this.ref !== null) {
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

    if (this.target === null || this.target.inPlace) {
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
function findTargetRefusal(pick: TargetPick, github: boolean): string | null {
  if (!pick.available) {
    return `target '${pick.id}' is unavailable on this daemon · esc back`;
  }

  if (!pick.takesWorkspace && (github || !pick.inPlace)) {
    return `target '${pick.id}' cannot take a workspace · esc back`;
  }

  return null;
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

// Why the daemon gave no repository list, in the words the notice row uses.
function formatListFailure(error: unknown): string {
  if (!(error instanceof DaemonError)) {
    return String(error);
  }

  if (error.code === 'unknown_method') {
    return 'this daemon cannot list repositories';
  }

  return error.message;
}

function parseListedRepos(raw: unknown): ListedRepo[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry: unknown): ListedRepo[] =>
    isRecord(entry) &&
    typeof entry['nameWithOwner'] === 'string' &&
    typeof entry['url'] === 'string' &&
    typeof entry['sshUrl'] === 'string'
      ? [
          {
            nameWithOwner: entry['nameWithOwner'],
            description: typeof entry['description'] === 'string' ? entry['description'] : '',
            isPrivate: entry['isPrivate'] === true,
            url: entry['url'],
            sshUrl: entry['sshUrl'],
          },
        ]
      : [],
  );
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
