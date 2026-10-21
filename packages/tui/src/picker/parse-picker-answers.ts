import type { AgentEntry, GitProbeResult, SourceEntry, SourceInterpretation } from '@atc/protocol';
import {
  AGENT_ENTRY_SCHEMA,
  GIT_PROBE_RESULT_SCHEMA,
  SOURCE_CANDIDATE_SCHEMA,
  SOURCE_ENTRY_SCHEMA,
  SOURCE_INTERPRETATION_SCHEMA,
} from '@atc/protocol';
import type { ListedCandidate } from './picker-flow';

export function parseCandidates(raw: unknown): ListedCandidate[] {
  return collectParsed(raw, (entry) => {
    const candidate = SOURCE_CANDIDATE_SCHEMA.safeParse(entry).data;

    return candidate === undefined
      ? undefined
      : { label: candidate.label, detail: candidate.detail ?? null, pick: candidate.pick };
  });
}

export function parseListedAgents(raw: unknown): AgentEntry[] {
  return collectParsed(raw, (entry) => AGENT_ENTRY_SCHEMA.safeParse(entry).data);
}

export function parseAnnouncedSources(raw: unknown): SourceEntry[] {
  return collectParsed(raw, (entry) => SOURCE_ENTRY_SCHEMA.safeParse(entry).data);
}

export function parseInterpretation(
  answer: Readonly<Record<string, unknown>>,
): SourceInterpretation {
  return SOURCE_INTERPRETATION_SCHEMA.safeParse(answer).data ?? { kind: 'none' };
}

export function parseProbeResult(answer: Readonly<Record<string, unknown>>): GitProbeResult | null {
  return GIT_PROBE_RESULT_SCHEMA.safeParse(answer).data ?? null;
}

function collectParsed<T>(raw: unknown, parse: (entry: unknown) => T | undefined): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry: unknown) => {
    const parsed = parse(entry);

    return parsed === undefined ? [] : [parsed];
  });
}
