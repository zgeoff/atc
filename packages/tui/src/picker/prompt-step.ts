import { DaemonError } from '@atc/protocol/wire';
import { pickRefusalStep } from '../pick-refusal-step';
import { cols } from '../ui';
import type { RequestOutcome } from './create-picker-actors';
import { formatPickerError } from './format-picker-error';
import { quitFlow, refreshRefs, renderFlow, sendPending } from './navigate-picker';
import type { PickerFlow } from './picker-flow';
import { buildSourceParams } from './picker-params';
import { buildDestination, isGitFlow } from './picker-queries';

export function applyPromptSubmit(flow: PickerFlow) {
  sendSpawn(flow, flow.ctx.input.trim());
}

export function applyPromptCancel(flow: PickerFlow) {
  flow.ctx.input = flow.ctx.name;
  flow.ctx.step = 'name';

  renderFlow(flow, true);
}

export function sendSpawn(flow: PickerFlow, prompt: string) {
  const ctx = flow.ctx;
  const deps = flow.deps;
  const git = isGitFlow(ctx);

  sendPending(flow, {
    kind: 'spawn',
    label: git ? 'materializing the workspace…' : 'spawning…',
    params: {
      ...(git && ctx.autoDestination !== null ? {} : { cwd: ctx.directory }),
      name: ctx.name,
      prompt,
      cols: cols(),
      rows: deps.ptyRows(),
      ...(ctx.resume ? { resume: true } : {}),
      agent: ctx.agent,
      ...buildSourceParams(ctx),
    },
    prompt,
  });
}

// Attaches the started session, or first shows the warnings the daemon
// started it with. A refused spawn goes to the step that can fix it.
export function applySpawnOutcome(
  flow: PickerFlow,
  outcome: Extract<RequestOutcome, { readonly kind: 'spawn' }>,
) {
  const ctx = flow.ctx;

  if (!outcome.ok) {
    applySpawnRefusal(flow, outcome.error, outcome.request.prompt);

    return;
  }

  if (outcome.sessionID === null) {
    quitFlow(flow);

    return;
  }

  flow.effects.push({ kind: 'stop' });

  // A workspace that left changes behind says so before the session's
  // screen takes over.
  if (outcome.warnings.length > 0) {
    ctx.spawnedID = outcome.sessionID;
    ctx.spawnedWarnings = outcome.warnings;
    ctx.step = 'spawned';

    renderFlow(flow, true);

    return;
  }

  flow.effects.push({ kind: 'attach', sessionID: outcome.sessionID });
}

// a refused git workspace spawn returns to the step that can fix it; any other refusal
// stays on the step that sent it with the entered text back, so the user can fix the
// cause and retry or back out.
function applySpawnRefusal(flow: PickerFlow, error: unknown, prompt: string) {
  const ctx = flow.ctx;
  const reason = formatPickerError(error);
  const code = error instanceof DaemonError ? error.code : 'internal';
  const step = isGitFlow(ctx) ? pickRefusalStep(code) : null;

  if (step === 'ref') {
    refreshRefs(flow, reason);

    return;
  }

  if (step === 'destination' && ctx.autoDestination !== null) {
    // The daemon already tried the numbered directories beside its pick.
    ctx.step = 'confirm';
    ctx.input = '';
    ctx.refusal = `${reason} · esc back`;
  } else if (step === 'destination') {
    ctx.destinationAttempt += 1;
    ctx.step = 'confirm';
    ctx.input = buildDestination(ctx);
    ctx.refusal = `${reason} · ⏎ use ${buildDestination(ctx)} · esc back`;
  } else if (step === 'source') {
    ctx.input = ctx.repo?.label ?? '';
    ctx.repo = null;
    ctx.step = 'source';
    ctx.refusal = `${reason} · esc back`;
  } else if (step === 'confirm') {
    const phase =
      error instanceof DaemonError && typeof error.data?.['phase'] === 'string'
        ? ` while ${error.data['phase']}`
        : '';

    ctx.step = 'confirm';
    ctx.input = buildDestination(ctx);
    ctx.refusal = `${reason}${phase} · esc back`;
  } else {
    ctx.refusal = `${reason} · ⏎ retry · esc back`;
    ctx.input = ctx.resume ? ctx.name : prompt;
  }

  renderFlow(flow, true);
}
