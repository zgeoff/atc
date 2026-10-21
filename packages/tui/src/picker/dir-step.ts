import { isGitURL, isPathInput } from '@atc/core';
import type { CompletionOutcome, PathListingOutcome } from './create-picker-actors';
import {
  applyDir,
  collectReadOrder,
  openAgentStep,
  openGitSource,
  readTypedInput,
  renderFlow,
} from './navigate-picker';
import type { PickerFlow } from './picker-flow';
import { buildClientCwdParam, buildPathTargetParam } from './picker-params';
import { collectDirItems, findSource } from './picker-queries';

// Takes the directory step's choice: a listed or completed directory, or
// else what the sources read the text as.
export function applyDirSubmit(flow: PickerFlow) {
  const typed = flow.ctx.input.trim();
  const chosen = collectDirItems(flow.ctx)[flow.ctx.selected];

  if (chosen !== undefined) {
    applyDir(flow, chosen);

    return;
  }

  if (typed !== '') {
    readTypedInput(flow, typed, collectReadOrder(flow, true), { kind: 'refuse' });
  }
}

export function applyDirCancel(flow: PickerFlow) {
  openAgentStep(flow);
}

export function applyDirInput(flow: PickerFlow, value: string) {
  const ctx = flow.ctx;

  // A pasted URL in the directory step is a repository, not a path, so the
  // flow moves to the first source of repositories with it.
  if (!ctx.resume && isGitURL(value) && !value.startsWith('/')) {
    const index = ctx.sources.findIndex((source) => source.kind === 'git');

    if (index !== -1) {
      openGitSource(flow, index, value, { kind: 'none' });

      return;
    }
  }

  // Typing a path waits for a pause before the daemon completes it, so a
  // burst of keys sends one request.
  if (isPathInput(value)) {
    scheduleCompletion(flow, value);
  }

  renderFlow(flow);
}

// Opens the directory step on the listing the daemon answered, with the
// client's own directory first unless the daemon runs on another host.
export function applyPathListing(flow: PickerFlow, outcome: PathListingOutcome) {
  const ctx = flow.ctx;
  const deps = flow.deps;

  const listed = outcome.candidates.flatMap((candidate) =>
    candidate.pick.kind === 'path' ? [[candidate.pick.directory, candidate.label] as const] : [],
  );

  const own = deps.remoteDaemon === true ? [] : [deps.cwd];

  ctx.pathListing = false;
  ctx.sourceIndex = outcome.request.index;

  ctx.dirLabels = new Map(listed);

  ctx.dirs = [...new Set([...own, ...listed.map(([directory]) => directory)])];
  ctx.input = '';
  ctx.selected = 0;
  ctx.step = 'dir';

  // A failed listing is no empty one, so the step shows why until the next
  // key.
  if (outcome.failure !== null) {
    flow.effects.push({ kind: 'log', line: `directory listing failed: ${outcome.failure}` });

    ctx.refusal = `cannot list directories: ${outcome.failure}`;
  }

  renderFlow(flow, true);
}

// Shows the daemon's completions of the typed path. A refused completion is
// no empty one: the step shows why until the next key, and the input
// completes again on that key.
export function applyCompletion(flow: PickerFlow, outcome: CompletionOutcome) {
  const ctx = flow.ctx;
  const input = outcome.request.input;

  ctx.completion = null;

  if (outcome.failure !== null) {
    flow.effects.push({ kind: 'log', line: `path completion failed: ${outcome.failure}` });

    ctx.refusal = `cannot complete ${input}: ${outcome.failure}`;
    ctx.completed = null;

    renderFlow(flow);

    return;
  }

  const labels = new Map(
    outcome.candidates.flatMap((candidate) =>
      candidate.pick.kind === 'path' ? [[candidate.pick.directory, candidate.label] as const] : [],
    ),
  );

  ctx.completed = { input, labels };

  renderFlow(flow);
}

// Asks the daemon's source of directories to complete a typed path once
// typing pauses: the flow's own source, else the first of directories.
function scheduleCompletion(flow: PickerFlow, input: string) {
  const ctx = flow.ctx;
  const deps = flow.deps;
  const own = findSource(ctx);
  const source = own?.kind === 'path' ? own : ctx.sources.find((entry) => entry.kind === 'path');

  if (source === undefined) {
    return;
  }

  ctx.completion = {
    input,
    params: {
      source: source.id,
      input,
      ...buildPathTargetParam(ctx, deps),
      ...buildClientCwdParam(deps),
    },
  };

  flow.effects.push({ kind: 'complete' });
}
