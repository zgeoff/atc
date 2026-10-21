import type { AgentEntry, SourceEntry, SourceInterpretation } from '@atc/protocol';
import { fromPromise } from 'xstate';
import { collectTargetPicks } from '../collect-target-picks';
import type { TargetPick } from '../collect-target-picks';
import { formatPickerError } from './format-picker-error';
import {
  parseAnnouncedSources,
  parseCandidates,
  parseInterpretation,
  parseListedAgents,
} from './parse-picker-answers';
import type {
  CompletionRequest,
  DroppedAnswer,
  GitListingRequest,
  ListedCandidate,
  PathListingRequest,
  PickerRequest,
  SpawnPickerDeps,
} from './picker-flow';
import { canTakeReading } from './picker-queries';

type Answer = Readonly<Record<string, unknown>>;

// The daemon's agents, targets, and sources, as one agent list answers them.
export interface AgentList {
  readonly agents: readonly AgentEntry[];
  readonly targets: readonly TargetPick[];
  readonly sources: readonly SourceEntry[];
}

// What a request the step waits on answers.
export type RequestOutcome =
  | { readonly kind: 'agents'; readonly list: AgentList | null; readonly failure: string | null }
  | {
      readonly kind: 'read';
      readonly request: Extract<PickerRequest, { readonly kind: 'read' }>;
      readonly accepted: { readonly index: number; readonly reading: SourceInterpretation } | null;
      readonly failures: readonly string[];
    }
  | {
      readonly kind: 'probe';
      readonly request: Extract<PickerRequest, { readonly kind: 'probe' }>;
      readonly answer: Answer | null;
      readonly error: unknown;
    }
  | {
      readonly kind: 'spawn';
      readonly request: Extract<PickerRequest, { readonly kind: 'spawn' }>;
      readonly sessionID: string | null;
      readonly warnings: readonly string[];
      readonly error: unknown;
      readonly ok: boolean;
    };

export interface PathListingOutcome {
  readonly request: PathListingRequest;
  readonly candidates: readonly ListedCandidate[];
  readonly failure: string | null;
}

export interface GitListingOutcome {
  readonly request: GitListingRequest;
  readonly answer: Answer | null;
  readonly error: unknown;
}

export interface CompletionOutcome {
  readonly request: CompletionRequest;
  readonly candidates: readonly ListedCandidate[];
  readonly failure: string | null;
}

// The requests the picker runs as invoked actors. Each one that settles after
// the state that invoked it was left reports the dropped answer and changes
// nothing else, since xstate drops a stopped actor's result.
export function createPickerActors<TMirror extends { readonly id: string }>(
  deps: SpawnPickerDeps<TMirror>,
) {
  const sendAnswered = async (
    method: string,
    params?: Answer,
  ): Promise<{ readonly answer: Answer | null; readonly error: unknown }> => {
    try {
      return { answer: await deps.sendRequest(method, params), error: null };
    } catch (error) {
      return { answer: null, error };
    }
  };

  const reportDrop = (signal: AbortSignal, kind: DroppedAnswer) => {
    if (signal.aborted) {
      deps.onDropAnswer?.(kind);
    }
  };

  return {
    request: fromPromise<RequestOutcome, PickerRequest>(async (args) => {
      const input = args.input;

      if (input.kind === 'agents') {
        const sent = await sendAnswered('agents.list');

        reportDrop(args.signal, 'agent list');

        return {
          kind: 'agents',
          list:
            sent.answer === null
              ? null
              : {
                  agents: parseListedAgents(sent.answer['agents']),
                  targets: collectTargetPicks(sent.answer),
                  sources: parseAnnouncedSources(sent.answer['sources']),
                },
          failure: sent.answer === null ? formatPickerError(sent.error) : null,
        };
      }

      if (input.kind === 'read') {
        const failures: string[] = [];

        for (const attempt of input.attempts) {
          const sent = await sendAnswered('sources.interpret', attempt.params);

          reportDrop(args.signal, 'interpret');

          if (args.signal.aborted) {
            return { kind: 'read', request: input, accepted: null, failures };
          }

          if (sent.answer === null) {
            if (attempt.countsRefusal) {
              failures.push(formatPickerError(sent.error));
            }

            continue;
          }

          const reading = parseInterpretation(sent.answer);

          if (canTakeReading(attempt.sourceKind, reading)) {
            return {
              kind: 'read',
              request: input,
              accepted: { index: attempt.index, reading },
              failures,
            };
          }
        }

        return { kind: 'read', request: input, accepted: null, failures };
      }

      if (input.kind === 'probe') {
        const sent = await sendAnswered('git.probe', input.params);

        reportDrop(args.signal, 'probe');

        return { kind: 'probe', request: input, answer: sent.answer, error: sent.error };
      }

      const sent = await sendAnswered('session.spawn', input.params);

      const session = sent.answer === null ? null : deps.toMirrorSession(sent.answer['session']);

      reportDrop(args.signal, 'spawn');

      if (session !== null && !args.signal.aborted) {
        deps.upsertMirror(session);
      }

      const warnings = sent.answer?.['warnings'];

      return {
        kind: 'spawn',
        request: input,
        sessionID: session === null ? null : session.id,
        warnings: Array.isArray(warnings)
          ? warnings.filter((warning): warning is string => typeof warning === 'string')
          : [],
        error: sent.error,
        ok: sent.answer !== null,
      };
    }),
    pathListing: fromPromise<PathListingOutcome, PathListingRequest>(async (args) => {
      const sent = await sendAnswered('sources.list', args.input.params);

      reportDrop(args.signal, 'directory listing');

      return {
        request: args.input,
        candidates: sent.answer === null ? [] : parseCandidates(sent.answer['candidates']),
        failure: sent.answer === null ? formatPickerError(sent.error) : null,
      };
    }),
    gitListing: fromPromise<GitListingOutcome, GitListingRequest>(async (args) => {
      const sent = await sendAnswered('sources.list', args.input.params);

      // a late answer still holds what the daemon lists, so the cache keeps it. An empty one
      // replaces a kept list too, so a repository the daemon no longer lists never comes back
      // from the cache.
      if (sent.answer !== null && Array.isArray(sent.answer['candidates'])) {
        void deps.listingCache?.writeListing(args.input.key, {
          candidates: sent.answer['candidates'],
          scope: typeof sent.answer['scope'] === 'string' ? sent.answer['scope'] : args.input.scope,
          listedAt: args.input.requestedAt,
        });
      }

      reportDrop(args.signal, 'listing');

      return { request: args.input, answer: sent.answer, error: sent.error };
    }),
    completion: fromPromise<CompletionOutcome, CompletionRequest>(async (args) => {
      const sent = await sendAnswered('sources.complete', args.input.params);

      reportDrop(args.signal, 'path completion');

      return {
        request: args.input,
        candidates: sent.answer === null ? [] : parseCandidates(sent.answer['completions']),
        failure: sent.answer === null ? formatPickerError(sent.error) : null,
      };
    }),
  };
}
