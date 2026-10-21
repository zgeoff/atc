import { match } from 'ts-pattern';
import { KEY, planTextEdit } from '../keys';
import type { TextEdit } from '../keys';
import { applyAgentSubmit } from './agent-step';
import { applyConfirmCancel, applyConfirmSubmit } from './confirm-step';
import { applyDirInput, applyDirSubmit } from './dir-step';
import { applyNameCancel, applyNameSubmit } from './name-step';
import { openAgentStep, openSource, quitFlow, renderFlow } from './navigate-picker';
import type { PickerFlow } from './picker-flow';
import { applyPromptCancel, applyPromptSubmit } from './prompt-step';
import { applyRefCancel, applyRefSubmit } from './ref-step';
import {
  applySourceCancel,
  applySourceInput,
  applySourceSubmit,
  refreshCandidates,
} from './source-step';
import { applySpawnedKey } from './spawned-step';
import { applyTargetCancel, applyTargetSubmit } from './target-step';

export function applyPickerKey(flow: PickerFlow, buf: Buffer) {
  const ctx = flow.ctx;
  const deps = flow.deps;

  ctx.refusal = null;

  if (ctx.step === 'spawned') {
    applySpawnedKey(flow, buf);

    return;
  }

  const edit = planTextEdit(buf, ctx.input, {
    isLeaderKey: deps.isLeaderKey,
    moves:
      ctx.step === 'agent' ||
      ctx.step === 'dir' ||
      ctx.step === 'source' ||
      ctx.step === 'ref' ||
      ctx.step === 'target',
  });

  if (ctx.pending !== null) {
    if (edit.kind === 'cancel') {
      applyPendingCancel(flow);
    } else if (edit.kind === 'leader') {
      quitFlow(flow);
    }

    return;
  }

  if (
    ctx.step === 'agent' &&
    ctx.agentStepWait !== null &&
    edit.kind !== 'cancel' &&
    edit.kind !== 'leader'
  ) {
    return;
  }

  const tab = buf.length === 1 && buf[0] === KEY.tab;

  if (!tab && (ctx.step === 'dir' || ctx.step === 'source')) {
    cancelPathListing(flow);
  }

  if (tab) {
    if (!ctx.resume && (ctx.step === 'dir' || ctx.step === 'source')) {
      openNextSource(flow);
    }

    return;
  }

  if (ctx.step === 'source' && edit.kind !== 'leader' && buf.length === 1 && buf[0] === KEY.ctrlR) {
    refreshCandidates(flow);

    return;
  }

  applyEdit(flow, edit);
}

// A spawn goes on on the daemon, which lists the session once it starts, so
// the flow leaves rather than offer to spawn it again.
function applyPendingCancel(flow: PickerFlow) {
  const cancelled = flow.ctx.pending;

  flow.ctx.pending = null;

  flow.effects.push({ kind: 'cancel-request' });

  if (cancelled?.kind === 'spawn') {
    quitFlow(flow);

    return;
  }

  flow.ctx.refusal = 'cancelled · esc back';

  renderFlow(flow, true);
}

function cancelPathListing(flow: PickerFlow) {
  if (flow.ctx.pathListing) {
    flow.ctx.pathListing = false;

    flow.effects.push({ kind: 'cancel-path-listing' });
  }
}

function openNextSource(flow: PickerFlow) {
  const ctx = flow.ctx;

  if (ctx.sources.length < 2) {
    flow.effects.push({ kind: 'log', line: 'ignored tab with one source' });

    return;
  }

  openSource(flow, (ctx.sourceIndex + 1) % ctx.sources.length);
}

function applyEdit(flow: PickerFlow, edit: TextEdit) {
  const ctx = flow.ctx;

  match(edit)
    .with({ kind: 'none' }, () => {})
    .with({ kind: 'cancel' }, () => {
      applyCancel(flow);
    })
    .with({ kind: 'leader' }, () => {
      quitFlow(flow);
    })
    .with({ kind: 'submit' }, (submit) => {
      ctx.input = submit.value;

      applySubmit(flow);
    })
    .with({ kind: 'move' }, (move) => {
      ctx.selected = move.delta === 1 ? ctx.selected + 1 : Math.max(0, ctx.selected - 1);

      renderFlow(flow);
    })
    .with({ kind: 'input' }, (input) => {
      applyInput(flow, input.value);
    })
    .exhaustive();
}

function applyCancel(flow: PickerFlow) {
  const ctx = flow.ctx;

  cancelPathListing(flow);

  match(ctx.step)
    .with('agent', () => {
      quitFlow(flow);
    })
    .with('source', () => {
      applySourceCancel(flow);
    })
    .with('ref', () => {
      applyRefCancel(flow);
    })
    .with('dir', () => {
      ctx.input = '';

      openAgentStep(flow);
    })
    .with('target', () => {
      ctx.input = '';

      applyTargetCancel(flow);
    })
    .with('confirm', () => {
      ctx.input = '';

      applyConfirmCancel(flow);
    })
    .with('name', () => {
      ctx.input = '';

      applyNameCancel(flow);
    })
    .with('prompt', 'spawned', () => {
      applyPromptCancel(flow);
    })
    .exhaustive();
}

function applySubmit(flow: PickerFlow) {
  match(flow.ctx.step)
    .with('agent', () => {
      applyAgentSubmit(flow);
    })
    .with('dir', () => {
      applyDirSubmit(flow);
    })
    .with('source', () => {
      applySourceSubmit(flow);
    })
    .with('ref', () => {
      applyRefSubmit(flow);
    })
    .with('target', () => {
      applyTargetSubmit(flow);
    })
    .with('confirm', () => {
      applyConfirmSubmit(flow);
    })
    .with('name', () => {
      applyNameSubmit(flow);
    })
    .with('prompt', 'spawned', () => {
      applyPromptSubmit(flow);
    })
    .exhaustive();
}

function applyInput(flow: PickerFlow, value: string) {
  const ctx = flow.ctx;

  if (ctx.step === 'target') {
    flow.effects.push({ kind: 'log', line: 'ignored text on the target step' });

    return;
  }

  ctx.input = value;

  if (ctx.step === 'dir') {
    applyDirInput(flow, value);
  } else if (ctx.step === 'source') {
    applySourceInput(flow);
  } else {
    renderFlow(flow);
  }
}
