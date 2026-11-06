import { LOCAL_TARGET } from '@atc/config';
import { buildWorkspaceDestination } from '@atc/core';
import type { SourceEntry, SourceInterpretation } from '@atcx/contract';
import { match } from 'ts-pattern';
import { formatDir } from '../dirs';
import { resolveWorkspaceRoot } from '../resolve-workspace-root';
import { canPickOnTarget } from './can-pick-on-target';
import { parseCandidates } from './parse-picker-answers';
import type {
  GitPick,
  ListedCandidate,
  PickerContext,
  PickerFlow,
  PickerRequest,
  ProbedRepo,
  ReadAttempt,
  ReadFollowUp,
  SourceListing,
} from './picker-flow';
import {
  buildClientCwdParam,
  buildListingKey,
  buildListingTargetParam,
  buildPathTargetParam,
  buildTargetParam,
} from './picker-params';
import {
  buildDestination,
  collectEligibleTargets,
  collectListItems,
  findEffectiveTarget,
  getListItemIndex,
  isGitFlow,
  pickListingTarget,
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

export function openList(flow: PickerFlow) {
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

  const listed = collectListedIndexes(ctx);

  if (listed.length === 0) {
    ctx.refusal =
      ctx.sources.length === 0
        ? 'the daemon offers no sources · set sources · esc cancel'
        : 'no directory source to adopt in · set sources · esc cancel';

    renderFlow(flow);

    return;
  }

  ctx.listingTarget = pickListingTarget(ctx.targets);

  ctx.listings = new Map();

  ctx.listMark = null;
  ctx.sourceIndex = -1;
  ctx.alternateURL = null;
  ctx.input = '';
  ctx.selected = 0;
  ctx.step = 'list';

  for (const index of listed) {
    listSource(flow, index, null);
  }

  renderFlow(flow, true);
}

// An adopt runs in a directory on this host, so it lists no git source.
function collectListedIndexes(ctx: PickerContext): number[] {
  return ctx.sources.flatMap((source, index) =>
    ctx.resume && source.kind !== 'path' ? [] : [index],
  );
}

function listSource(flow: PickerFlow, index: number, scope: string | null) {
  const ctx = flow.ctx;
  const source = ctx.sources[index];

  if (source === undefined) {
    return;
  }

  if (source.kind === 'path') {
    replaceListing(ctx, source.id, {
      status: 'listing',
      rows: scope === null ? buildOwnRows(flow, source.id) : [],
      requestedScope: scope,
      scope,
      notice: null,
      listedFrom: null,
    });

    flow.effects.push({
      kind: 'list',
      request: {
        kind: 'path',
        sourceID: source.id,
        index,
        params: {
          source: source.id,
          ...(scope === null ? {} : { scope }),
          ...buildPathTargetParam(ctx, flow.deps),
        },
      },
    });

    return;
  }

  const target = ctx.listingTarget;

  if (target === null) {
    replaceListing(ctx, source.id, {
      status: 'skipped',
      rows: [],
      requestedScope: scope,
      scope,
      notice: 'no target takes a workspace',
      listedFrom: null,
    });

    return;
  }

  const key = buildListingKey(flow.deps, source.id, target.id, scope);
  const cached = flow.deps.listingCache?.readListing(key, flow.deps.clock.now()) ?? null;
  const kept = cached !== null && (cached.candidates.length > 0 || cached.scope !== null);
  const rows = kept ? parseCandidates(cached.candidates, source.id) : [];
  const keptScope = kept ? cached.scope : null;

  replaceListing(ctx, source.id, {
    status: 'listing',
    rows,
    requestedScope: scope,
    scope: kept ? keptScope : scope,
    notice: rows.length === 0 && keptScope !== null ? `nothing listed for ${keptScope}` : null,
    listedFrom: kept ? cached.listedAt : null,
  });

  sendGitListing(flow, source.id, target.id, scope);
}

export function refreshListings(flow: PickerFlow) {
  const ctx = flow.ctx;
  const target = ctx.listingTarget;

  if (target === null) {
    return;
  }

  for (const source of ctx.sources) {
    const listing = ctx.listings.get(source.id);

    if (source.kind === 'git' && listing !== undefined) {
      replaceListing(ctx, source.id, { ...listing, status: 'listing' });
      sendGitListing(flow, source.id, target.id, listing.requestedScope);
    }
  }

  renderFlow(flow);
}

function sendGitListing(
  flow: PickerFlow,
  sourceID: string,
  targetID: string,
  scope: string | null,
) {
  flow.effects.push({
    kind: 'list',
    request: {
      kind: 'git',
      sourceID,
      scope,
      key: buildListingKey(flow.deps, sourceID, targetID, scope),
      requestedAt: flow.deps.clock.now(),
      params: { source: sourceID, ...(scope === null ? {} : { scope }), target: targetID },
    },
  });
}

export function stopListings(flow: PickerFlow) {
  for (const [sourceID, listing] of flow.ctx.listings) {
    if (listing.status === 'listing') {
      flow.effects.push({ kind: 'cancel-listing', sourceID });
    }
  }

  flow.ctx.listings = new Map();
}

// This host's directory stands for nothing on a remote daemon's host.
export function buildOwnRows(flow: PickerFlow, sourceID: string): ListedCandidate[] {
  const deps = flow.deps;

  if (deps.remoteDaemon === true) {
    return [];
  }

  return [
    {
      sourceID,
      label: formatDir(deps.cwd),
      detail: null,
      pick: { kind: 'path', directory: deps.cwd },
    },
  ];
}

export function replaceListing(ctx: PickerFlow['ctx'], sourceID: string, listing: SourceListing) {
  ctx.listings = new Map([...ctx.listings, [sourceID, listing]]);
}

export function openListAgain(flow: PickerFlow) {
  const ctx = flow.ctx;
  const mark = ctx.listMark;

  ctx.step = 'list';
  ctx.input = mark?.input ?? '';
  ctx.alternateURL = null;
  ctx.selected = getListItemIndex(collectListItems(ctx), mark ?? { sourceID: null, label: null });

  renderFlow(flow, true);
}

export function startGitPick(flow: PickerFlow, index: number, pick: GitPick) {
  const ctx = flow.ctx;

  ctx.sourceIndex = index;
  ctx.gitPick = pick;

  if (openTargetStep(flow)) {
    renderFlow(flow, true);

    return;
  }

  checkRepoAccess(flow, pick.label, pick.url);
}

export function openTargetStep(flow: PickerFlow): boolean {
  const ctx = flow.ctx;
  const git = isGitFlow(ctx);
  const eligible = collectEligibleTargets(ctx, git);

  if (eligible.length === 1 || (ctx.targets.length === 0 && ctx.targetGap === null)) {
    // The spawn names the one usable target, default or not, so its provider decides whether
    // a directory runs in place.
    ctx.target = eligible[0] ?? null;

    return false;
  }

  const preferred = git
    ? ctx.listingTarget
    : (ctx.target ?? ctx.targets.find((target) => target.isDefault));

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
    } else if (target !== null && !target.inPlace && canPickOnTarget(ctx.workspaces, target.id)) {
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

export function applyDir(flow: PickerFlow, index: number, directory: string) {
  const ctx = flow.ctx;

  ctx.sourceIndex = index;
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

  match(reading)
    .with({ kind: 'none' }, () => {})
    .with({ kind: 'path' }, (path) => {
      applyDir(flow, index, path.directory);
    })
    .with({ kind: 'git' }, (git) => {
      startGitPick(flow, index, { label: typed, url: git.url });
    })
    .with({ kind: 'browse' }, (browse) => {
      const sourceID = ctx.sources[index]?.id ?? null;

      listSource(flow, index, browse.scope);

      ctx.input = '';
      ctx.selected = getListItemIndex(collectListItems(ctx), { sourceID, label: null });

      renderFlow(flow, true);
    })
    .exhaustive();
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
            ? buildListingTargetParam(flow.ctx)
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

export function collectSourceIndexes(ctx: PickerContext, kind: SourceEntry['kind']): number[] {
  return ctx.sources.flatMap((source, index) => (source.kind === kind ? [index] : []));
}

export function checkRepoAccess(flow: PickerFlow, label: string, url: string) {
  sendPending(flow, {
    kind: 'probe',
    label: `checking access to ${url}…`,
    params: { url, ...buildTargetParam(flow.ctx) },
    followUp: { kind: 'access', label },
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
