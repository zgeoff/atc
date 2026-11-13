import type { PickerContext, PickerDeps, PickerFlow } from './picker-flow';
import { collectEligibleTargets, findEffectiveTarget, isGitFlow } from './picker-queries';

export function buildTargetParam(ctx: PickerContext): Readonly<Record<string, string>> {
  return ctx.target === null ? {} : { target: ctx.target.id };
}

// A principal may hold no default target, and a config that lists targets
// may name none, so a request without one fails on the daemon. A local
// daemon falls back on its own default when it has one.
export function buildPathTargetParam(ctx: PickerContext): Readonly<Record<string, string>> {
  const eligible = collectEligibleTargets(ctx, false);
  const fallback = eligible.find((candidate) => candidate.isDefault);

  if (ctx.daemon === null && fallback !== undefined) {
    return {};
  }

  const target = ctx.target ?? fallback ?? eligible[0];

  return target === undefined ? {} : { target: target.id };
}

export function buildClientCwdParam(
  ctx: PickerContext,
  deps: PickerDeps,
): Readonly<Record<string, string>> {
  return ctx.daemon === null ? { clientCwd: deps.cwd } : {};
}

// A git source lists under one target for the whole list, chosen before the
// user picks one, since the daemon refuses a git listing without a target
// that takes a workspace.
export function buildListingTargetParam(ctx: PickerContext): Readonly<Record<string, string>> {
  return ctx.listingTarget === null ? {} : { target: ctx.listingTarget.id };
}

export function buildListingKey(
  flow: PickerFlow,
  sourceID: string,
  targetID: string,
  scope: string | null,
): string {
  const socketPath = flow.deps.getDaemonSocketPath?.(flow.ctx.daemon) ?? '';

  return [socketPath, sourceID, targetID, scope ?? ''].join('\n');
}

export function buildSourceParams(ctx: PickerContext): Readonly<Record<string, unknown>> {
  const target = buildTargetParam(ctx);

  if (isGitFlow(ctx) && ctx.repo !== null && ctx.ref !== null) {
    return {
      ...target,
      workspace: {
        kind: 'git',
        url: ctx.repo.url,
        ...(ctx.ref.ref === null ? {} : { ref: ctx.ref.ref }),
        sha: ctx.ref.sha,
      },
    };
  }

  const effective = findEffectiveTarget(ctx);

  if (effective === null || effective.inPlace) {
    return target;
  }

  return { ...target, workspace: { kind: 'path', path: ctx.directory } };
}
