import { LOCAL_TARGET } from '@atc/config';
import { buildWorkspaceDestination, isHomeRelative } from '@atc/core';
import type { SourceInterpretation } from '@atc/protocol';
import { resolveWorkspaceRoot } from '../resolve-workspace-root';
import { parseCandidates } from './parse-picker-answers';
import type {
  PickerFlow,
  PickerRequest,
  ProbedRepo,
  ReadAttempt,
  ReadFollowUp,
  SourceStepAction,
} from './picker-flow';
import {
  buildClientCwdParam,
  buildListingKey,
  buildPathTargetParam,
  buildTargetParam,
} from './picker-params';
import {
  buildDestination,
  collectEligibleTargets,
  findEffectiveTarget,
  findSource,
  isGitFlow,
} from './picker-queries';

const AUTO_ROOT = '~/.local/share/atc/workspaces';

export function renderFlow(flow: PickerFlow, clear = false) {
  flow.effects.push({ kind: 'render', clear, ctx: { ...flow.ctx } });
}

export function quitFlow(flow: PickerFlow) {
  flow.effects.push({ kind: 'quit' });
}

export function sendPending(
  flow: PickerFlow,
  request: Exclude<PickerRequest, { readonly kind: 'agents' }>,
) {
  const kind = request.kind === 'read' ? 'interpret' : request.kind;
  const esc = kind === 'spawn' ? 'esc stops waiting; the session still lists' : 'esc cancels';

  flow.ctx.pending = { label: `${request.label} · ${esc}`, kind };

  flow.effects.push({ kind: 'request', request });

  renderFlow(flow);
}

export function openAgentStep(flow: PickerFlow) {
  const ctx = flow.ctx;

  if (ctx.picks.length === 1) {
    quitFlow(flow);

    return;
  }

  ctx.selected = Math.max(
    0,
    ctx.picks.findIndex((pick) => pick.agent === ctx.agent),
  );

  ctx.agentStepWait = null;
  ctx.step = 'agent';

  renderFlow(flow, true);
}

export function openFirstSource(flow: PickerFlow) {
  const ctx = flow.ctx;
  const brokered = ctx.listedAgents.some((entry) => entry.id === ctx.agent && entry.brokerRequired);
  const picks = ctx.listedTargets.filter((target) => !brokered || target.brokerAuth);

  // An adopt resumes a session from its history on this host, which a
  // fresh checkout elsewhere does not hold.
  ctx.targets = ctx.resume ? picks.filter((target) => target.available && target.inPlace) : picks;
  ctx.targetGap = null;

  if (ctx.listedTargets.length > 0 && picks.length === 0) {
    ctx.targetGap = `no target reaches the credential broker ${ctx.agent} needs`;
  } else if (ctx.listedTargets.length > 0 && ctx.targets.length === 0) {
    ctx.targetGap = 'no target on this host can adopt a session';
  }

  const index = ctx.resume ? ctx.sources.findIndex((source) => source.kind === 'path') : 0;

  if (ctx.sources.length > 0 && index !== -1) {
    ctx.agentStepWait = 'reading sources…';

    openSource(flow, index);

    return;
  }

  ctx.refusal =
    ctx.sources.length === 0
      ? 'the daemon offers no sources · set workspaces.sources · esc cancel'
      : 'no directory source to adopt in · set workspaces.sources · esc cancel';

  renderFlow(flow);
}

export function openSource(flow: PickerFlow, index: number) {
  const source = flow.ctx.sources[index];

  if (source?.kind === 'path') {
    openPathSource(flow, index, null);
  } else if (source?.kind === 'git') {
    openGitSource(flow, index, '', { kind: 'none' });
  }
}

export function openPathSource(flow: PickerFlow, index: number, scope: string | null) {
  const source = flow.ctx.sources[index];

  if (source === undefined) {
    return;
  }

  flow.ctx.pathListing = true;

  flow.effects.push({
    kind: 'list-path',
    request: {
      index,
      params: {
        source: source.id,
        ...(scope === null ? {} : { scope }),
        ...buildPathTargetParam(flow.ctx, flow.deps),
      },
    },
  });
}

export function openGitSource(
  flow: PickerFlow,
  index: number,
  draft: string,
  action: SourceStepAction,
) {
  const ctx = flow.ctx;
  const fromGit = isGitFlow(ctx);

  ctx.pathListing = false;
  ctx.sourceIndex = index;
  ctx.sourceDraft = draft;
  ctx.sourceAction = action;

  flow.effects.push({ kind: 'cancel-path-listing' });

  if (fromGit) {
    openSourceStep(flow);

    return;
  }

  if (openTargetStep(flow)) {
    renderFlow(flow, true);

    return;
  }

  openSourceStep(flow);
}

export function openSourceStep(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.step = 'source';
  ctx.input = ctx.sourceDraft;
  ctx.selected = 0;
  ctx.alternateURL = null;

  const action = ctx.sourceAction;

  ctx.sourceAction = { kind: 'none' };

  const key = `${findSource(ctx)?.id ?? ''}\n${ctx.target?.id ?? ''}`;
  const stale = ctx.listedKey !== key;

  if (stale) {
    ctx.listedKey = key;
    ctx.candidates = [];
    ctx.listedScope = null;
    ctx.listNotice = null;
    ctx.listedFrom = null;
    ctx.refreshFailure = null;
  }

  const scope = action.kind === 'browse' ? action.scope : null;

  if (action.kind === 'browse' || stale) {
    restoreCachedCandidates(flow, scope);
  }

  renderFlow(flow, true);

  if (action.kind === 'browse' || stale) {
    loadCandidates(flow, scope);
  }

  if (action.kind === 'probe') {
    checkRepoAccess(flow, ctx.sourceDraft, action.url);
  }
}

function restoreCachedCandidates(flow: PickerFlow, scope: string | null) {
  const ctx = flow.ctx;
  const deps = flow.deps;
  const source = findSource(ctx);
  const cache = deps.listingCache;

  ctx.listedFrom = null;
  ctx.refreshFailure = null;

  if (source === null || cache === undefined) {
    return;
  }

  const cached = cache.readListing(buildListingKey(ctx, deps, source.id, scope), deps.clock.now());

  if (cached === null || (cached.candidates.length === 0 && cached.scope === null)) {
    return;
  }

  ctx.candidates = parseCandidates(cached.candidates);
  ctx.listedScope = cached.scope;
  ctx.listedFrom = cached.listedAt;

  ctx.listNotice =
    ctx.candidates.length === 0 && ctx.listedScope !== null
      ? `nothing listed for ${ctx.listedScope}`
      : null;
}

export function loadCandidates(flow: PickerFlow, scope: string | null) {
  const ctx = flow.ctx;
  const deps = flow.deps;
  const source = findSource(ctx);

  if (source === null) {
    return;
  }

  ctx.listing = { sourceID: source.id };
  ctx.requestedScope = scope;

  flow.effects.push({
    kind: 'list-git',
    request: {
      sourceID: source.id,
      scope,
      key: buildListingKey(ctx, deps, source.id, scope),
      requestedAt: deps.clock.now(),
      params: {
        source: source.id,
        ...(scope === null ? {} : { scope }),
        ...buildTargetParam(ctx),
      },
    },
  });

  renderFlow(flow);
}

export function openTargetStep(flow: PickerFlow): boolean {
  const ctx = flow.ctx;
  const eligible = collectEligibleTargets(ctx);

  if (eligible.length === 1 || (ctx.targets.length === 0 && ctx.targetGap === null)) {
    // The spawn names the one usable target, default or not, so its provider decides whether
    // a directory runs in place.
    ctx.target = eligible[0] ?? null;

    return false;
  }

  const preferred =
    ctx.target ??
    (isGitFlow(ctx)
      ? (ctx.targets.find((target) => target.isDefault && target.takesWorkspace) ??
        ctx.targets.find((target) => target.takesWorkspace))
      : undefined) ??
    ctx.targets.find((target) => target.isDefault);

  ctx.selected = Math.max(
    0,
    ctx.targets.findIndex((target) => target.id === preferred?.id),
  );

  ctx.input = '';
  ctx.step = 'target';

  return true;
}

export function openRefStep(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.step = 'ref';
  ctx.input = ctx.ref === null ? '' : (ctx.ref.ref ?? ctx.ref.sha);
  ctx.selected = 0;
}

export function openConfirmStep(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.step = 'confirm';
  ctx.destinationAttempt = 1;
  ctx.autoDestination = null;

  if (ctx.destination === '' && ctx.repo !== null && ctx.ref !== null) {
    const target = findEffectiveTarget(ctx);

    const root = resolveWorkspaceRoot(ctx.workspaces, {
      id: target?.id ?? LOCAL_TARGET.id,
      inPlace: target?.inPlace ?? true,
    });

    if (root.ok) {
      ctx.destinationRepoURL = ctx.repo.url;

      ctx.destination = buildWorkspaceDestination({
        root: root.root,
        url: ctx.repo.url,
        ref: ctx.ref.ref,
        sha: ctx.ref.sha,
      });
    } else if (target !== null && !target.inPlace && canPickOnTarget(flow, target.id)) {
      ctx.autoDestination = buildWorkspaceDestination({
        root: ctx.workspaces.targetRoots.get(target.id) ?? ctx.workspaces.root ?? AUTO_ROOT,
        url: ctx.repo.url,
        ref: ctx.ref.ref,
        sha: ctx.ref.sha,
      });
    } else {
      ctx.refusal = root.message;
    }
  }

  ctx.input = buildDestination(ctx);
}

export function applyDir(flow: PickerFlow, directory: string) {
  const ctx = flow.ctx;

  ctx.directory = directory;
  ctx.input = '';

  if (!openTargetStep(flow)) {
    ctx.step = 'name';
  }

  renderFlow(flow, true);
}

export function applyReading(
  flow: PickerFlow,
  index: number,
  reading: SourceInterpretation,
  typed: string,
) {
  const ctx = flow.ctx;

  if (reading.kind === 'none') {
    return;
  }

  if (reading.kind === 'path') {
    ctx.sourceIndex = index;

    applyDir(flow, reading.directory);

    return;
  }

  const scope = reading.kind === 'browse' ? reading.scope : null;

  if (ctx.sources[index]?.kind === 'path') {
    openPathSource(flow, index, scope);

    return;
  }

  if (index !== ctx.sourceIndex || ctx.step !== 'source') {
    const action: SourceStepAction =
      reading.kind === 'git'
        ? { kind: 'probe', url: reading.url }
        : { kind: 'browse', scope: reading.scope };

    const draft = reading.kind === 'git' ? typed : '';

    openGitSource(flow, index, draft, action);

    return;
  }

  if (reading.kind === 'browse') {
    ctx.input = '';
    ctx.selected = 0;

    restoreCachedCandidates(flow, reading.scope);
    loadCandidates(flow, reading.scope);

    return;
  }

  checkRepoAccess(flow, typed, reading.url);
}

export function readTypedInput(
  flow: PickerFlow,
  typed: string,
  indexes: readonly number[],
  followUp: ReadFollowUp,
) {
  const attempts: ReadAttempt[] = indexes.flatMap((index) => {
    const source = flow.ctx.sources[index];

    if (source === undefined) {
      return [];
    }

    return [
      {
        index,
        sourceKind: source.kind,
        params: {
          source: source.id,
          input: typed,
          ...(source.kind === 'git'
            ? buildTargetParam(flow.ctx)
            : {
                ...buildPathTargetParam(flow.ctx, flow.deps),
                ...buildClientCwdParam(flow.deps),
              }),
        },
        countsRefusal: followUp.kind === 'refuse',
      },
    ];
  });

  sendPending(flow, { kind: 'read', typed, label: `reading ${typed}…`, attempts, followUp });
}

export function collectReadOrder(flow: PickerFlow, withOwn: boolean): number[] {
  const others = flow.ctx.sources.flatMap((_, index) =>
    index === flow.ctx.sourceIndex ? [] : [index],
  );

  return withOwn ? [flow.ctx.sourceIndex, ...others] : others;
}

export function checkRepoAccess(flow: PickerFlow, label: string, url: string) {
  sendPending(flow, {
    kind: 'probe',
    label: `checking access to ${url}…`,
    params: { url, ...buildTargetParam(flow.ctx) },
    followUp: { kind: 'access', label, url },
  });
}

export function refreshRefs(flow: PickerFlow, reason: string) {
  const repo: ProbedRepo | null = flow.ctx.repo;

  if (repo === null) {
    return;
  }

  openRefStep(flow);

  sendPending(flow, {
    kind: 'probe',
    label: `re-reading refs of ${repo.url}…`,
    params: { url: repo.url, ...buildTargetParam(flow.ctx) },
    followUp: { kind: 'refresh', reason, repo },
  });
}

function canPickOnTarget(flow: PickerFlow, target: string): boolean {
  const configured = flow.ctx.workspaces.targetRoots.get(target) ?? flow.ctx.workspaces.root;

  return configured === null || isHomeRelative(configured);
}
