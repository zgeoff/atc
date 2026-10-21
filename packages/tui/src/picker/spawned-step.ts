import { planTextEdit } from '../keys';
import type { PickerFlow } from './picker-flow';

export function applySpawnedKey(flow: PickerFlow, buf: Buffer) {
  const ctx = flow.ctx;
  const deps = flow.deps;
  const edit = planTextEdit(buf, '', { isLeaderKey: deps.isLeaderKey, moves: false });

  if (edit.kind !== 'submit' && edit.kind !== 'cancel' && edit.kind !== 'leader') {
    return;
  }

  const sessionID = ctx.spawnedID;

  ctx.spawnedID = null;
  ctx.spawnedWarnings = [];
  ctx.step = 'agent';

  if (edit.kind === 'submit' && sessionID !== null) {
    flow.effects.push({ kind: 'attach', sessionID });

    return;
  }

  flow.effects.push({ kind: 'show-base' });
}
