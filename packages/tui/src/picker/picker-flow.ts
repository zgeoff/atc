import type { Config, WorkspacesConfig } from '@atc/config';
import type { AgentID, Clock } from '@atc/core';
import type { AgentEntry, GitRef, SourceEntry, SourcePick } from '@atc/protocol';
import type { TargetPick } from '../collect-target-picks';
import type { ListingCache } from '../listing-cache';

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
// request a step waits on, the daemon's agents, targets, and sources, and the
// daemon's path completions.
export type DroppedAnswer =
  | 'listing'
  | 'directory listing'
  | 'path completion'
  | 'interpret'
  | 'probe'
  | 'spawn'
  | 'agent list';

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

  // The config the flow reads its workspace settings from each time it
  // opens.
  readonly readConfig: () => Config;

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

// The deps a step reads; the session type only matters to the request
// that builds the started session.
export type PickerDeps = Omit<SpawnPickerDeps<unknown>, 'toMirrorSession' | 'upsertMirror'>;

// One agent the menu offers.
export interface AgentPick {
  readonly agent: AgentID;
  readonly label: string;
}

// One candidate `sources.list` returned.
export interface ListedCandidate {
  readonly label: string;
  readonly detail: string | null;
  readonly pick: SourcePick;
}

// The repository the probe proved the daemon's host can read.
export interface ProbedRepo {
  // What the user chose, shown as the source step's input on the way back
  // to it.
  readonly label: string;

  // The URL the clone fetches, as the daemon resolved it.
  readonly url: string;
  readonly head: string | null;
  readonly refs: readonly GitRef[];
}

// The commit the spawn checks out, and the branch or tag it came from.
export interface ChosenRef {
  readonly ref: string | null;
  readonly sha: string;
}

// What a git source step does once it opens: nothing, probe a URL a
// reading of typed input already resolved, or list the scope a reading
// asked for, once the step's target is known.
export type SourceStepAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'probe'; readonly url: string }
  | { readonly kind: 'browse'; readonly scope: string };

// A request a step waits on: Esc cancels it, and every other key waits.
interface PendingRequest {
  readonly label: string;
  readonly kind: 'interpret' | 'probe' | 'spawn';
}

// The git listing that runs behind the source step, for the source it
// lists.
interface RunningListing {
  readonly sourceID: string;
}

export interface PickerContext {
  readonly step: PickerStep;
  readonly resume: boolean;

  // The sources the daemon offers, and the one the flow is on; -1 before
  // the flow opens one.
  readonly sources: readonly SourceEntry[];
  readonly sourceIndex: number;
  readonly input: string;
  readonly selected: number;

  // The agents the daemon can start, read each time the menu opens so a
  // config edit or a fresh install lands without a client restart, and every
  // agent its answer lists.
  readonly picks: readonly AgentPick[];
  readonly listedAgents: readonly AgentEntry[];

  // The daemon's execution targets, as its agent list gives them.
  readonly listedTargets: readonly TargetPick[];

  // What the agent step waits on, the daemon's agents or the first source's
  // listing, or null when it waits on nothing.
  readonly agentStepWait: string | null;

  // The directories the directory step lists, and the label each shows.
  readonly dirs: readonly string[];
  readonly dirLabels: ReadonlyMap<string, string>;

  // The daemon's completions of a typed path with the label each shows, for
  // the input they complete, and the completion that waits for typing to
  // pause or for its answer.
  readonly completed: {
    readonly input: string;
    readonly labels: ReadonlyMap<string, string>;
  } | null;
  readonly completion: CompletionRequest | null;

  // The configured workspace settings, read each time the menu opens.
  readonly workspaces: WorkspacesConfig;
  readonly directory: string;

  // The targets the flow offers, and the one chosen; null spawns on the
  // daemon's default target.
  readonly targets: readonly TargetPick[];
  readonly target: TargetPick | null;

  // Why the flow offers no target although the daemon lists some, or null
  // when it offers some or the daemon lists none.
  readonly targetGap: string | null;

  // the git source's candidates, or the notice standing in for a list the daemon could not
  // give, for the source and target they were listed for. A listing runs behind the step,
  // so typing goes on.
  readonly candidates: readonly ListedCandidate[];
  readonly listedScope: string | null;
  readonly listNotice: string | null;
  readonly listedKey: string | null;
  readonly listing: RunningListing | null;

  // When the shown candidates were listed, if they came from the listing
  // cache rather than from a listing the step made, and why the listing
  // that would replace them failed.
  readonly listedFrom: number | null;
  readonly refreshFailure: string | null;

  // The scope the step last asked for, which a refresh asks for again.
  readonly requestedScope: string | null;

  // Whether the flow waits on a directory listing before it opens the
  // directory step.
  readonly pathListing: boolean;

  // The source step's text while the flow is on another step, and what the
  // step does as soon as it opens.
  readonly sourceDraft: string;
  readonly sourceAction: SourceStepAction;

  // The other URL form of a repository whose probe failed, offered as the
  // source step's one item until the input changes.
  readonly alternateURL: string | null;
  readonly repo: ProbedRepo | null;
  readonly ref: ChosenRef | null;

  // The destination on the confirm screen, before any suffix a refused
  // spawn adds, that suffix's number, and whether the user typed the
  // destination rather than taking the default.
  readonly destination: string;
  readonly destinationAttempt: number;
  readonly destinationEdited: boolean;

  // The repository the destination was built or typed for.
  readonly destinationRepoURL: string | null;

  // The directory the daemon picks on the target when the confirm screen
  // has no destination it can build, under the target user's home as the
  // screen shows it, or null when the spawn gives its own.
  readonly autoDestination: string | null;
  readonly name: string;
  readonly agent: AgentID;

  // Why the last action was refused, shown in place of the hint until the
  // next key.
  readonly refusal: string | null;
  readonly pending: PendingRequest | null;

  // A session the daemon started with warnings, and those warnings, shown
  // before the flow attaches it.
  readonly spawnedID: string | null;
  readonly spawnedWarnings: readonly string[];
}

// The context a step changes while it handles one key or answer.
type PickerDraft = { -readonly [Key in keyof PickerContext]: PickerContext[Key] };

// What a step asks the machine to do once its context is in place.
type PickerEffect =
  | { readonly kind: 'request'; readonly request: PickerRequest }
  | { readonly kind: 'cancel-request' }
  | { readonly kind: 'list-path'; readonly request: PathListingRequest }
  | { readonly kind: 'cancel-path-listing' }
  | { readonly kind: 'list-git'; readonly request: GitListingRequest }
  | { readonly kind: 'cancel-git-listing' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'cancel-completion' }
  | { readonly kind: 'render'; readonly clear: boolean; readonly ctx: PickerContext }
  | { readonly kind: 'quit' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'attach'; readonly sessionID: string }
  | { readonly kind: 'show-base' }
  | { readonly kind: 'log'; readonly line: string };

// A step's working state while it handles one key or answer: the draft it
// changes, the effects it asks for, and the deps it reads.
export interface PickerFlow {
  readonly ctx: PickerDraft;
  readonly effects: PickerEffect[];
  readonly deps: PickerDeps;
}

// The requests a step waits on, at most one at a time.
export type PickerRequest =
  | { readonly kind: 'agents' }
  | {
      readonly kind: 'read';
      readonly typed: string;
      readonly label: string;
      readonly attempts: readonly ReadAttempt[];
      readonly followUp: ReadFollowUp;
    }
  | {
      readonly kind: 'probe';
      readonly label: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly followUp: ProbeFollowUp;
    }
  | {
      readonly kind: 'spawn';
      readonly label: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly prompt: string;
    };

// One source asked what typed text is, in order, with the params of its
// request and whether its refusal counts toward the refusal the step shows.
export interface ReadAttempt {
  readonly index: number;
  readonly sourceKind: SourceEntry['kind'];
  readonly params: Readonly<Record<string, unknown>>;
  readonly countsRefusal: boolean;
}

// What the step does with a reading no source took: show the refusal, or,
// on the git source step, go on through the selected candidate or the other
// sources.
export type ReadFollowUp =
  | { readonly kind: 'refuse' }
  | { readonly kind: 'source-fallback'; readonly candidate: ListedCandidate | null };

// What a probe answers: access to a chosen repository, the refs again after
// a refused spawn, or a ref the listing left out.
type ProbeFollowUp =
  | { readonly kind: 'access'; readonly label: string; readonly url: string }
  | { readonly kind: 'refresh'; readonly reason: string; readonly repo: ProbedRepo }
  | { readonly kind: 'resolve'; readonly typed: string };

export interface PathListingRequest {
  readonly index: number;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface GitListingRequest {
  readonly sourceID: string;
  readonly scope: string | null;
  readonly key: string;
  readonly requestedAt: number;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface CompletionRequest {
  readonly input: string;
  readonly params: Readonly<Record<string, unknown>>;
}
