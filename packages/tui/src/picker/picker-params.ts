import type { PickerContext, PickerDeps } from './picker-flow';
import { collectEligibleTargets, findEffectiveTarget, isGitFlow } from './picker-queries';

// The target every git source request is made for: the chosen one, or none
// for the daemon's default when there is no choice to make.
export function buildTargetParam(ctx: PickerContext): Readonly<Record<string, string>> {
  return ctx.target === null ? {} : { target: ctx.target.id };
}

// The target a remote daemon checks a directory request against: the
// chosen one, else the default the caller may use, else the first, since a
// principal may hold no default target. A local request sends none.
export function buildPathTargetParam(
  ctx: PickerContext,
  deps: PickerDeps,
): Readonly<Record<string, string>> {
  if (deps.remoteDaemon !== true) {
    return {};
  }

  const eligible = collectEligibleTargets(ctx);
  const target = ctx.target ?? eligible.find((candidate) => candidate.isDefault) ?? eligible[0];

  return target === undefined ? {} : { target: target.id };
}

// The client's directory, which a typed relative path reads from when the
// daemon runs on the client's machine; a remote daemon gets none.
export function buildClientCwdParam(deps: PickerDeps): Readonly<Record<string, string>> {
  return deps.remoteDaemon === true ? {} : { clientCwd: deps.cwd };
}

// The key a listing is kept under in the listing cache: the daemon, the
// source, the target, and the scope.
export function buildListingKey(
  ctx: PickerContext,
  deps: PickerDeps,
  sourceID: string,
  scope: string | null,
): string {
  return [deps.getDaemonSocketPath?.() ?? '', sourceID, ctx.target?.id ?? '', scope ?? ''].join(
    '\n',
  );
}

// a repository goes at the commit the confirm screen showed. A local directory runs in
// place on a target on the daemon's own machine, and on any other is materialized at the
// same path from its pushed HEAD.
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
