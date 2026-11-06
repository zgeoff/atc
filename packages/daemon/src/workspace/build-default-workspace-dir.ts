import { buildWorkspaceDestination } from '@atc/core';
import type { SpawnWorkspaceSource } from '@atcx/contract';
import { buildWorkspaceRootDir } from './build-workspace-root-dir';

type GitWorkspaceSource = Extract<SpawnWorkspaceSource, { kind: 'git' }>;

export function buildDefaultWorkspaceDir(
  source: GitWorkspaceSource,
  target: Parameters<typeof buildWorkspaceRootDir>[0],
): string {
  return buildWorkspaceDestination({
    root: buildWorkspaceRootDir(target),
    url: source.url,
    ref: source.ref ?? null,
    sha: source.sha ?? null,
  });
}
