import type { AgentID } from '@atc/core';

export type {
  DaemonContext,
  ForgetRefusals,
  ForgetResult,
  HeldAtcAccess,
  KillOutcome,
  MessageRefusal,
  OutputClient,
  ReadEventsParams,
  SessionRecord,
  SessionTranscriptRead,
  SpawnParams,
  TapClient,
  WriteSessionMessageParams,
} from './daemon-context';

export type { DaemonOptions } from './daemon-options';

export interface LiveDefaults {
  defaultTarget: string | null;
  defaultAgent?: AgentID;
}
