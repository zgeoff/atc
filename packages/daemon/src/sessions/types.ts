import type { ExecutionProvider } from '@atc/plugin-api';
import type { HarnessPlan } from '../auth/create-auth-setup';
import type { DaemonContext } from '../types';

export interface TranscriptWindow {
  readonly size: number;
  readonly bytes: Uint8Array;
}

export type MessageView = NonNullable<Awaited<ReturnType<DaemonContext['readMessage']>>>;

// What a revive starts its harness with on the session's host.
export interface HarnessLaunch {
  readonly provider: ExecutionProvider;
  readonly plan: Omit<HarnessPlan, 'args'> & { readonly args: readonly string[] };
  readonly recordPath: string | null;
  readonly cols: number;
  readonly rows: number;
}
