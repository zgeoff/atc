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

// A request the step waits on, and the number that tells its answer from a
// cancelled one's.
interface PendingRequest {
  readonly label: string;
  readonly seq: number;
  readonly kind: 'probe' | 'spawn';
}

/**
 * The modal flow behind n and r: agent, then source, then name, then an
 * optional first prompt. A local directory source is followed by the
 * execution target when the daemon has more than one. Tab in a spawn
 * switches to a git repository source: the target first, then the
 * repository, its ref, and a confirm screen with the destination the
 * checkout lands in, so every request about the repository is made for
 * the target the spawn runs on. Every path out of the flow either attaches
 * the new session or returns the client to the screen it came from. A spawn
 * the daemon refuses is no path out: the flow returns to the step that can
 * fix the cause and shows why. Esc cancels a request in flight and drops
 * its late answer.
 */
export class SpawnPicker<TMirror extends { readonly id: string }> {
  private readonly deps: SpawnPickerDeps<TMirror>;

  private step: PickerStep = 'agent';

  private source: 'github' | 'local' = 'local';

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
  // in for a list the daemon could not give, with the target they were
  // listed for. A listing runs behind the step, so typing goes on.
  private repos: ListedRepo[] = [];

  private reposOwner: string | null = null;

  private reposNotice: string | null = null;

  private reposTarget: string | null = null;

  private listingSeq: number | null = null;

  private gitProtocol: 'https' | 'ssh' = 'https';

  // The repository step's text while the flow is on another step, and
  // whether the step submits it as soon as it opens.
  private repoDraft = '';

  private repoAutoSubmit = false;

  // The other URL form of a repository whose probe failed, offered as the
  // repository step's one item until the input changes.
  private alternateURL: string | null = null;

  private repo: ProbedRepo | null = null;

  private ref: ChosenRef | null = null;

  // The destination on the confirm screen, before any suffix a refused
  // spawn adds, that suffix's number, and whether the user typed the
  // destination rather than taking the default.
  private destination = '';

  private destinationAttempt = 1;

  private destinationEdited = false;

  private name = '';

  private resume = false;

  private agent: AgentID = 'claude';

  // Why the last action was refused, shown in place of the hint until the
  // next key.
  private refusal: string | null = null;

  private pending: PendingRequest | null = null;

  private requestSeq = 0;

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
    this.source = 'local';
    this.target = null;
    this.repo = null;
    this.ref = null;
    this.repoDraft = '';
    this.repoAutoSubmit = false;
    this.reposTarget = null;
    this.listingSeq = null;
    this.alternateURL = null;
    this.destination = '';
    this.destinationEdited = false;

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
        this.step === 'repo' ||
        this.step === 'ref' ||
        this.step === 'target',
    });

    // A request in flight owns the step: Esc cancels it, the leader leaves,
    // and every other key waits for the answer.
    if (this.pending !== null) {
      if (edit.kind === 'cancel') {
        this.applyPendingCancel();
      } else if (edit.kind === 'leader') {
        this.pending = null;

        this.deps.toBase();
      }

      return;
    }

    // Tab switches the source of a spawn between a local directory and a
    // git repository. Adopt resumes a session in a directory that already
    // holds one, so it stays local.
    if (buf.length === 1 && buf[0] === KEY.tab) {
      if (!this.resume && this.step === 'dir') {
        this.openGitHubSource('', false);
      } else if (!this.resume && this.step === 'repo') {
        this.openLocalSource();
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
      this.renderTargetStep(verb);
    } else if (this.step === 'confirm') {
      this.renderConfirmStep();
    } else if (this.step === 'name') {
      const where = this.source === 'github' ? this.formatDestination() : formatDir(this.dir);

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

  private renderTargetStep(verb: string) {
    this.selected = Math.min(this.selected, this.targets.length - 1);

    const github = this.source === 'github';
    const what = github ? 'the repository' : formatDir(this.dir);

    drawPicker({
      title: `${verb}: target`,
      items: this.targets.map((t) => formatTargetPick(t)),
      selected: this.selected,
      input: '',
      hint: this.refusal ?? `where ${what} runs · ↑↓ move · ⏎ select · esc back`,
      dimmed: new Set(
        this.targets.flatMap((t, i) =>
          t.takesWorkspace || (!github && t.available && t.inPlace) ? [] : [i],
        ),
      ),
    });
  }

  private renderRepoStep() {
    const items = this.collectRepoItems();

    this.selected = Math.min(this.selected, Math.max(0, Math.min(items.length, 10) - 1));

    const owner = this.reposOwner === null ? '' : ` · ${this.reposOwner}`;
    const listing = this.listingSeq === null ? null : 'listing repositories… · esc stops';

    drawPicker({
      title: `spawn: repository${owner}`,
      items: items.map((item) => item.label),
      selected: items.length === 0 || items[0]?.notice === true ? -1 : this.selected,
      input: this.input,
      hint:
        this.pending?.label ??
        this.refusal ??
        listing ??
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
      this.openGitHubSource(value, false);

      return;
    }

    this.render();
  }

  // Stops waiting on the request in flight. Its answer, when it comes, is
  // dropped. A spawn goes on on the daemon, which lists the session once
  // it starts.
  private applyPendingCancel() {
    const cancelled = this.pending;

    this.pending = null;

    this.refusal =
      cancelled?.kind === 'spawn'
        ? 'stopped waiting; the daemon finishes the spawn and lists the session · esc back'
        : 'cancelled · esc back';

    process.stdout.write(ansi.clear);
    this.render();
  }

  private applyCancel() {
    if (this.step === 'agent') {
      this.deps.toBase();

      return;
    }

    // Esc first stops a listing in flight, keeping the step.
    if (this.step === 'repo' && this.listingSeq !== null) {
      this.listingSeq = null;
      this.reposTarget = null;
      this.reposNotice = 'listing stopped — type owner/repo or a git URL';

      this.render();

      return;
    }

    const typed = this.input;

    this.input = '';

    if (this.step === 'dir') {
      this.selected = Math.max(
        0,
        this.picks.findIndex((p) => p.agent === this.agent),
      );

      this.step = 'agent';
    } else if (this.step === 'repo') {
      this.repoDraft = typed;

      this.applyRepoCancel();
    } else if (this.step === 'ref') {
      this.input = this.repo?.label ?? '';
      this.repo = null;
      this.step = 'repo';
    } else if (this.step === 'target') {
      this.source = 'local';
      this.step = 'dir';
    } else if (this.step === 'confirm') {
      this.openRefStep();
    } else if (this.step === 'name') {
      if (this.source === 'github') {
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

  // Leaves the repository step backwards: to the target step when the
  // daemon has more than one target, else to the agent.
  private applyRepoCancel() {
    if (this.targets.length >= 2) {
      this.openTargetStep(() => {});

      return;
    }

    this.source = 'local';

    this.selected = Math.max(
      0,
      this.picks.findIndex((p) => p.agent === this.agent),
    );

    this.step = 'agent';
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
        this.openGitHubSource(this.input, true);

        return;
      }

      const chosen =
        items[this.selected] ?? resolvePathInput(this.input.trim(), process.cwd(), homedir());

      if (chosen === null) {
        return;
      }

      this.dir = chosen;
      this.input = '';

      this.openTargetStep(() => {
        this.step = 'name';
      });
    } else if (this.step === 'target') {
      this.applyTargetSubmit();

      return;
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

  private applyTargetSubmit() {
    const pick = this.targets[this.selected];

    if (pick === undefined) {
      return;
    }

    const refusal = findTargetRefusal(pick, this.source === 'github');

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

    if (this.source === 'github') {
      this.openRepoStep();

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

  private openLocalSource() {
    this.source = 'local';
    this.listingSeq = null;
    this.step = 'dir';
    this.input = '';
    this.selected = 0;

    process.stdout.write(ansi.clear);
    this.render();
  }

  // Switches to a git repository source, carrying the typed text across:
  // the target step first when the daemon has more than one target, then
  // the repository step, which submits the text at once when asked to.
  private openGitHubSource(input: string, submit: boolean) {
    this.source = 'github';
    this.repoDraft = input;
    this.repoAutoSubmit = submit;

    if (this.targets.length >= 2) {
      this.openTargetStep(() => {});
      process.stdout.write(ansi.clear);
      this.render();

      return;
    }

    this.target = null;

    this.openRepoStep();
  }

  // Opens the repository step with its draft, reading the list again when
  // the target changed since the last listing.
  private openRepoStep() {
    this.step = 'repo';
    this.input = this.repoDraft;
    this.selected = 0;
    this.alternateURL = null;

    process.stdout.write(ansi.clear);
    this.render();

    const target = this.target?.id ?? '';

    if (this.reposTarget !== target) {
      this.reposTarget = target;
      void this.loadRepos(this.workspaces.githubOwner);
    }

    if (this.repoAutoSubmit) {
      this.repoAutoSubmit = false;
      void this.applyRepoSubmit();
    }
  }

  // The target every repository request is made for: the chosen one, or
  // none for the daemon's default when there is no choice to make.
  private buildTargetParam(): Readonly<Record<string, string>> {
    return this.target === null ? {} : { target: this.target.id };
  }

  // Reads one owner's repositories from the daemon behind the step; null
  // reads its default owner's. A daemon that cannot list them leaves a
  // notice row. Typing goes on meanwhile, and Esc stops the listing.
  private async loadRepos(owner: string | null) {
    this.requestSeq += 1;

    const seq = this.requestSeq;

    this.listingSeq = seq;

    this.render();

    let answer: Readonly<Record<string, unknown>> | null = null;
    let failure: unknown = null;

    try {
      const params = { ...(owner === null ? {} : { owner }), ...this.buildTargetParam() };

      answer = await this.deps.sendRequest('repos.list', params);
    } catch (error) {
      failure = error;
    }

    if (this.listingSeq !== seq) {
      return;
    }

    this.listingSeq = null;

    if (answer === null) {
      this.repos = [];
      this.reposOwner = owner;
      this.reposNotice = `${formatListFailure(failure)} — type owner/repo or a git URL`;
    } else {
      this.repos = parseListedRepos(answer['repos']);
      this.reposOwner = typeof answer['owner'] === 'string' ? answer['owner'] : owner;
      this.gitProtocol = answer['gitProtocol'] === 'ssh' ? 'ssh' : 'https';

      this.reposNotice =
        this.repos.length === 0
          ? `no repositories listed for ${this.reposOwner ?? 'this account'}`
          : null;
    }

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

    this.pending = { label: `${label} · esc cancels`, seq, kind };

    this.render();

    let result:
      | { readonly ok: true; readonly answer: Readonly<Record<string, unknown>> }
      | { readonly ok: false; readonly error: unknown };

    try {
      result = { ok: true, answer: await this.deps.sendRequest(m, p) };
    } catch (error) {
      result = { ok: false, error };
    }

    if (this.pending?.seq !== seq) {
      return null;
    }

    this.pending = null;

    return result;
  }

  // Checks that the daemon's host can read the repository at this URL for
  // the spawn's target, and opens the ref step with its refs. A failure
  // stays on the repository step with git's error and offers the other URL
  // form when there is one.
  private async checkRepoAccess(label: string, url: string) {
    const probed = await this.sendPending('probe', `checking access to ${url}…`, 'repos.probe', {
      url,
      ...this.buildTargetParam(),
    });

    if (probed === null) {
      return;
    }

    if (!probed.ok) {
      this.alternateURL = findAlternateGitURL(url);
      this.selected = 0;
      this.refusal = `${formatError(probed.error)} · esc back`;
      this.input = label;

      process.stdout.write(ansi.clear);
      this.render();

      return;
    }

    this.repo = buildProbedRepo(label, url, probed.answer);
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

    const probed = await this.sendPending(
      'probe',
      `re-reading refs of ${repo.url}…`,
      'repos.probe',
      {
        url: repo.url,
        ...this.buildTargetParam(),
      },
    );

    if (probed === null) {
      return;
    }

    if (probed.ok) {
      this.repo = buildProbedRepo(repo.label, repo.url, probed.answer);
      this.refusal = `${reason} · refs re-read · esc back`;
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
    const probed = await this.sendPending('probe', `resolving ${typed}…`, 'repos.probe', {
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
      this.target = null;

      fallback();

      return;
    }

    const preferred =
      this.target ??
      (this.source === 'github'
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
    this.source = 'local';

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

    const label = this.source === 'github' ? 'materializing the workspace…' : 'spawning…';

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
      this.deps.toBase();

      return;
    }

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
    const step = this.source === 'github' ? pickRefusalStep(code) : null;

    if (step === 'ref') {
      void this.refreshRefs(reason);

      return;
    }

    if (step === 'destination') {
      this.destinationAttempt += 1;
      this.step = 'confirm';
      this.input = this.buildDestination();
      this.refusal = `${reason} · ⏎ use ${this.buildDestination()} · esc back`;
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
    const target = this.buildTargetParam();

    if (this.source === 'github' && this.repo !== null && this.ref !== null) {
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
