import { isRecord } from '@atc/core';

interface ToolErrorContent extends Record<string, unknown> {
  readonly code: string;
  readonly problem?: string;
}

// Only the code and the problem pass: the rest of an error's data can describe
// sessions or targets outside the caller's reach.
export function buildToolErrorContent(error: unknown): ToolErrorContent | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if ('code' in error && typeof error.code === 'string' && /^[a-z][a-z_]*$/u.test(error.code)) {
    const data: unknown = 'data' in error ? error.data : undefined;
    const problem = isRecord(data) ? data['problem'] : undefined;

    return typeof problem === 'string' ? { code: error.code, problem } : { code: error.code };
  }

  // A wrapped refusal keeps its code on the error it wraps.
  return buildToolErrorContent(error.cause);
}
