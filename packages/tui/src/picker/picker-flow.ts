import type { Config, WorkspacesConfig } from '@atc/config';
import type { AgentID, Clock } from '@atc/core';
import type { AgentEntry, GitRef, SourceEntry, SourcePick } from '@atcx/contract';
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

export type DroppedAnswer =
  | 'listing'
  | 'directory listing'
  | 'path completion'
  | 'interpret'
  | 'probe'
  | 'spawn'
  | 'agent list';

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

  readonly write: (chunk: string) => void;

  readonly cwd: string;

  readonly home: string;

  // The client's own directory stands for nothing on a remote daemon's host.
  readonly remoteDaemon?: boolean;

  readonly readConfig: () => Config;

  readonly onDropAnswer?: (kind: DroppedAnswer) => void;

  readonly log?: (line: string) => void;

  readonly listingCache?: ListingCache;

  readonly getDaemonSocketPath?: () => string;

  readonly clock: Clock;
}

export type PickerDeps = Omit<SpawnPickerDeps<unknown>, 'toMirrorSession' | 'upsertMirror'>;

export interface AgentPick {
  readonly agent: AgentID;
  readonly label: string;
}

export interface ListedCandidate {
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

export type SourceStepAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'probe'; readonly url: string }
  | { readonly kind: 'browse'; readonly scope: string };

interface PendingRequest {
  readonly label: string;
  readonly kind: 'interpret' | 'probe' | 'spawn';
}

interface RunningListing {
  readonly sourceID: string;
}

export interface PickerContext {
  readonly step: PickerStep;
  readonly resume: boolean;

  readonly sources: readonly SourceEntry[];
  readonly sourceIndex: number;
  readonly input: string;
  readonly selected: number;

  readonly picks: readonly AgentPick[];
  readonly listedAgents: readonly AgentEntry[];

  readonly listedTargets: readonly TargetPick[];

  readonly agentStepWait: string | null;

  readonly dirs: readonly string[];
  readonly dirLabels: ReadonlyMap<string, string>;

  readonly completed: {
    readonly input: string;
    readonly labels: ReadonlyMap<string, string>;
  } | null;
  readonly completion: CompletionRequest | null;

  readonly workspaces: WorkspacesConfig;
  readonly directory: string;

  readonly targets: readonly TargetPick[];
  readonly target: TargetPick | null;

  readonly targetGap: string | null;

  readonly candidates: readonly ListedCandidate[];
  readonly listedScope: string | null;
  readonly listNotice: string | null;
  readonly listedKey: string | null;
  readonly listing: RunningListing | null;

  readonly listedFrom: number | null;
  readonly refreshFailure: string | null;

  readonly requestedScope: string | null;

  readonly pathListing: boolean;

  readonly sourceDraft: string;
  readonly sourceAction: SourceStepAction;

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
  | { readonly kind: 'source-fallback'; readonly candidate: ListedCandidate | null };

type ProbeFollowUp =
  | { readonly kind: 'access'; readonly label: string }
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
