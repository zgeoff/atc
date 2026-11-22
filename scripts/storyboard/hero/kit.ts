import { buildSceneKit } from '@zgeoff/storyboard';
import tokens from './tokens.ts';

export const {
  Stage,
  Beat,
  buildTerminal,
  Line,
  Type,
  Status,
  Alert,
  Flight,
  Pulse,
  Cursor,
  Stamp,
  Def,
  Animate,
  Ambient,
  getColor,
  getID,
  getURL,
  defineHost,
} = buildSceneKit(tokens);

export type TokenName = Parameters<typeof getColor>[0];
