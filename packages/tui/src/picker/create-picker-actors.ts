import type { AgentEntry, GitProbeResult, SourceEntry, SourceInterpretation } from '@atcx/contract';
import { fromCallback, fromPromise } from 'xstate';
import { collectTargetPicks } from '../collect-target-picks';
import type { TargetPick } from '../collect-target-picks';
import { canTakeReading } from './can-take-reading';
import { formatPickerError } from './format-picker-error';
import {
  parseAnnouncedSources,
  parseCandidates,
  parseInterpretation,
  parseListedAgents,
  parseProbeResult,
} from './parse-picker-answers';
import type {
  CompletionRequest,
  DroppedAnswer,
  ListedCandidate,
  ListingRequest,
  PickerRequest,
  SpawnPickerDeps,
} from './picker-flow';

type Answer = Readonly<Record<string, unknown>>;

export interface AgentList {
  readonly agents: readonly AgentEntry[];
  readonly targets: readonly TargetPick[];
  readonly sources: readonly SourceEntry[];
}

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
      readonly result: GitProbeResult | null;
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

export interface ListingOutcome<TRequest extends ListingRequest = ListingRequest> {
  readonly request: TRequest;
  readonly answer: Answer | null;
  readonly error: unknown;
}

export type ListingCommand =
  | { readonly type: 'LIST'; readonly request: ListingRequest }
  | { readonly type: 'CANCEL_LISTING'; readonly sourceID: string };

export interface CompletionOutcome {
  readonly request: CompletionRequest;
  readonly candidates: readonly ListedCandidate[];
  readonly failure: string | null;
}

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

        const result = sent.answer === null ? null : parseProbeResult(sent.answer);

        return {
          kind: 'probe',
          request: input,
          result,
          error:
            sent.answer !== null && result === null
              ? 'the daemon answered git.probe with a malformed result'
              : sent.error,
        };
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

    // One listing runs per source, so a listing of one source never stops
    // another's; a second listing of a source replaces its first.
    listings: fromCallback<ListingCommand>((args) => {
      const running = new Map<string, AbortController>();

      const runListing = async (request: ListingRequest, signal: AbortSignal) => {
        const sent = await sendAnswered('sources.list', request.params);

        if (
          request.kind === 'git' &&
          sent.answer !== null &&
          Array.isArray(sent.answer['candidates'])
        ) {
          void deps.listingCache?.writeListing(request.key, {
            candidates: sent.answer['candidates'],
            scope: typeof sent.answer['scope'] === 'string' ? sent.answer['scope'] : request.scope,
            listedAt: request.requestedAt,
          });
        }

        const dropped = request.kind === 'path' ? 'directory listing' : 'listing';

        reportDrop(signal, dropped);

        if (signal.aborted) {
          return;
        }

        running.delete(request.sourceID);

        args.sendBack({
          type: 'LISTED',
          outcome: { request, answer: sent.answer, error: sent.error },
        });
      };

      args.receive((command) => {
        const sourceID = command.type === 'LIST' ? command.request.sourceID : command.sourceID;

        running.get(sourceID)?.abort();
        running.delete(sourceID);

        if (command.type === 'LIST') {
          const controller = new AbortController();

          running.set(sourceID, controller);
          void runListing(command.request, controller.signal);
        }
      });

      return () => {
        for (const controller of running.values()) {
          controller.abort();
        }
      };
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
