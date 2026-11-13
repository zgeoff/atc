import type { Config, WorkspacesConfig } from '@atc/config';
import type { AgentID, Clock } from '@atc/core';
import type { AgentEntry, GitRef, SourceEntry, SourcePick } from '@atcx/contract';
import type { TargetPick } from '../collect-target-picks';
import type { ListingCache } from '../listing-cache';
import type { DaemonName } from '../session-key';

type PickerStep =
  | 'daemon'
  | 'agent'
  | 'list'
  | 'ref'
  | 'target'
  | 'confirm'
  | 'name'
  | 'prompt'
  | 'spawned';

export type DroppedAnswer =
  | 'listing'
  | 'directory listing'
  | 'path completion'
  | 'interpret'
  | 'probe'
  | 'spawn'
  | 'agent list';

export interface SpawnPickerDeps<TMirror> {
  // The daemon the picker opens on, and the one it skips the daemon step for.
  readonly primaryDaemon: DaemonName;

  // The daemons whose link is up, the primary first.
  readonly upDaemons: () => readonly DaemonName[];
  readonly sendRequest: (
    daemon: DaemonName,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly ptyRows: () => number;
  readonly isLeaderKey: (buf: Buffer) => boolean;
  readonly getLastUsedAgent: (daemon: DaemonName) => AgentID;
  readonly scheduleStatus: () => void;
  readonly showBase: () => void;
  readonly attach: (daemon: DaemonName, sessionID: string) => Promise<void>;
  readonly toMirrorSession: (daemon: DaemonName, value: unknown) => TMirror | null;
  readonly upsertMirror: (session: Readonly<TMirror>) => void;

  readonly write: (chunk: string) => void;

  readonly cwd: string;

  readonly home: string;

  readonly readConfig: () => Config;

  readonly onDropAnswer?: (kind: DroppedAnswer) => void;

  readonly log?: (line: string) => void;

  readonly getListingCache?: (daemon: DaemonName) => ListingCache | undefined;

  readonly getDaemonSocketPath?: (daemon: DaemonName) => string;

  readonly clock: Clock;
}

export type PickerDeps = Omit<SpawnPickerDeps<unknown>, 'toMirrorSession' | 'upsertMirror'>;

export interface AgentPick {
  readonly agent: AgentID;
  readonly label: string;
}

export interface ListedCandidate {
  readonly sourceID: string;
  readonly label: string;
  readonly detail: string | null;
  readonly pick: SourcePick;
}

export interface ProbedRepo {
  readonly label: string;

  readonly url: string;
  readonly head: string | null;
  readonly refs: readonly GitRef[];
}

export interface ChosenRef {
  readonly ref: string | null;
  readonly sha: string;
}

export interface SourceListing {
  readonly status: 'listing' | 'listed' | 'failed' | 'skipped';
  readonly rows: readonly ListedCandidate[];
  readonly requestedScope: string | null;
  readonly scope: string | null;
  readonly notice: string | null;
  readonly listedFrom: number | null;
}

export interface ItemMark {
  readonly sourceID: string | null;
  readonly label: string | null;
}

interface ListMark extends ItemMark {
  readonly input: string;
}

export interface GitPick {
  readonly label: string;
  readonly url: string;
}

interface PendingRequest {
  readonly label: string;
  readonly kind: 'interpret' | 'probe' | 'spawn';
}

// A request, listing or completion, stamped with the daemon it goes to.
export type OnDaemon<TRequest> = TRequest & { readonly daemon: DaemonName };

export interface PickerContext {
  readonly step: PickerStep;
  readonly resume: boolean;

  // The daemon every later step runs against; a name other than null takes a remote daemon's rules.
  readonly daemon: DaemonName;

  // The daemons the daemon step offers, empty when the picker skipped that step.
  readonly daemons: readonly DaemonName[];

  readonly sources: readonly SourceEntry[];
  readonly sourceIndex: number;
  readonly input: string;
  readonly selected: number;

  readonly picks: readonly AgentPick[];
  readonly listedAgents: readonly AgentEntry[];

  readonly listedTargets: readonly TargetPick[];

  readonly agentStepWait: string | null;

  readonly listings: ReadonlyMap<string, SourceListing>;
  readonly listingTarget: TargetPick | null;
  readonly listMark: ListMark | null;

  readonly completed: {
    readonly input: string;
    readonly sourceID: string;
    readonly labels: ReadonlyMap<string, string>;
  } | null;
  readonly completion: CompletionRequest | null;

  readonly workspaces: WorkspacesConfig;
  readonly directory: string;

  readonly targets: readonly TargetPick[];
  readonly target: TargetPick | null;

  readonly targetGap: string | null;

  readonly gitPick: GitPick | null;

  readonly alternateURL: string | null;
  readonly repo: ProbedRepo | null;
  readonly ref: ChosenRef | null;

  readonly destination: string;
  readonly destinationAttempt: number;
  readonly destinationEdited: boolean;

  readonly destinationRepoURL: string | null;

  readonly autoDestination: string | null;
  readonly name: string;
  readonly agent: AgentID;

  readonly refusal: string | null;
  readonly pending: PendingRequest | null;

  readonly spawnedID: string | null;
  readonly spawnedWarnings: readonly string[];
}

type PickerDraft = { -readonly [Key in keyof PickerContext]: PickerContext[Key] };

type PickerEffect =
  | { readonly kind: 'request'; readonly request: PickerRequest }
  | { readonly kind: 'cancel-request' }
  | { readonly kind: 'list'; readonly request: ListingRequest }
  | { readonly kind: 'cancel-listing'; readonly sourceID: string }
  | { readonly kind: 'complete' }
  | { readonly kind: 'cancel-completion' }
  | { readonly kind: 'render'; readonly clear: boolean; readonly ctx: PickerContext }
  | { readonly kind: 'quit' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'attach'; readonly daemon: DaemonName; readonly sessionID: string }
  | { readonly kind: 'show-base' }
  | { readonly kind: 'log'; readonly line: string };

export interface PickerFlow {
  readonly ctx: PickerDraft;
  readonly effects: PickerEffect[];
  readonly deps: PickerDeps;
}

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

export interface ReadAttempt {
  readonly index: number;
  readonly sourceKind: SourceEntry['kind'];
  readonly params: Readonly<Record<string, unknown>>;
  readonly countsRefusal: boolean;
}

export type ReadFollowUp =
  | { readonly kind: 'refuse' }
  | { readonly kind: 'list-fallback'; readonly candidate: ListedCandidate | null };

type ProbeFollowUp =
  | { readonly kind: 'access'; readonly label: string }
  | { readonly kind: 'refresh'; readonly reason: string; readonly repo: ProbedRepo }
  | { readonly kind: 'resolve'; readonly typed: string };

export type ListingRequest =
  | {
      readonly kind: 'path';
      readonly sourceID: string;
      readonly index: number;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'git';
      readonly sourceID: string;
      readonly scope: string | null;
      readonly key: string;
      readonly requestedAt: number;
      readonly params: Readonly<Record<string, unknown>>;
    };

export interface CompletionRequest {
  readonly input: string;
  readonly sourceID: string;
  readonly params: Readonly<Record<string, unknown>>;
}
