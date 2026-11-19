import { isRecord } from '@atc/core';
import { formatJSONKind } from '../config-file/format-json-kind';
import { collectSpritePrefixOverlaps } from './collect-sprite-prefix-overlaps';
import { LOCAL_TARGET } from './local-target';

export interface TargetConfig {
  readonly id: string;
  readonly provider: string;
  readonly options: Readonly<Record<string, unknown>>;
}

interface TargetSectionError {
  readonly scope: 'targets' | 'target' | 'defaultTarget';

  readonly target?: string;
  readonly problem: string;
}

interface ConfigFileError {
  readonly scope: 'config';
  readonly problem: 'config_malformed' | 'config_unreadable';
  readonly path: string;
  readonly detail: string;
}

export type TargetConfigError = TargetSectionError | ConfigFileError;

interface TargetsConfig {
  readonly targets: readonly TargetConfig[];

  readonly defaultTarget: string | null;
  readonly errors: readonly TargetConfigError[];
}

export function collectTargets(rawTargets: unknown, rawDefault: unknown): TargetsConfig {
  if (rawTargets === undefined && rawDefault === undefined) {
    return { targets: [LOCAL_TARGET], defaultTarget: LOCAL_TARGET.id, errors: [] };
  }

  const collected = collectTargetEntries(rawTargets);

  const ids = new Set(collected.targets.map((target) => target.id));

  if (rawDefault === undefined) {
    return {
      targets: collected.targets,
      defaultTarget: ids.has(LOCAL_TARGET.id) ? LOCAL_TARGET.id : null,
      errors: collected.errors,
    };
  }

  if (typeof rawDefault === 'string' && ids.has(rawDefault)) {
    return { targets: collected.targets, defaultTarget: rawDefault, errors: collected.errors };
  }

  // The problem gives the value's kind, never the value: a wrongly typed
  // defaultTarget can hold anything the file holds.
  const problem =
    typeof rawDefault === 'string'
      ? 'defaultTarget: matches no well-formed target in targets'
      : `defaultTarget: expected a string, got ${formatJSONKind(rawDefault)}`;

  return {
    targets: collected.targets,
    defaultTarget: null,
    errors: [...collected.errors, { scope: 'defaultTarget', problem }],
  };
}

interface TargetEntries {
  readonly targets: readonly TargetConfig[];
  readonly errors: readonly TargetSectionError[];
}

function collectTargetEntries(raw: unknown): TargetEntries {
  if (raw === undefined) {
    return { targets: [LOCAL_TARGET], errors: [] };
  }

  if (!isRecord(raw) || Array.isArray(raw) || Object.keys(raw).length === 0) {
    return {
      targets: [],
      errors: [
        { scope: 'targets', problem: 'targets must be a non-empty object of named targets' },
      ],
    };
  }

  const targets: TargetConfig[] = [];
  const errors: TargetSectionError[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    const provider = isRecord(entry) ? entry['provider'] : undefined;

    if (id === '' || !isRecord(entry) || typeof provider !== 'string' || provider === '') {
      errors.push({
        scope: 'target',
        target: id,
        problem: `target ${JSON.stringify(id)} must be an object with a non-empty string provider`,
      });

      continue;
    }

    if (
      entry['trustClonedWorkspace'] !== undefined &&
      typeof entry['trustClonedWorkspace'] !== 'boolean'
    ) {
      errors.push({
        scope: 'target',
        target: id,
        problem: `target ${JSON.stringify(id)} must give trustClonedWorkspace as a boolean`,
      });

      continue;
    }

    const { provider: _, ...options } = entry;

    targets.push({ id, provider, options });
  }

  return refuseOverlappingSpritePrefixes(targets, errors);
}

// Neither target of an overlapping pair stays: each one's sprites would use the connectors of the
// other's access policy.
function refuseOverlappingSpritePrefixes(
  targets: readonly TargetConfig[],
  errors: readonly TargetSectionError[],
): TargetEntries {
  const overlaps = collectSpritePrefixOverlaps(targets);

  if (overlaps.length === 0) {
    return { targets, errors };
  }

  const refused = new Set(overlaps.flatMap((overlap) => [overlap.shorter, overlap.longer]));

  return {
    targets: targets.filter((target) => !refused.has(target.id)),
    errors: [
      ...errors,
      ...overlaps.map((overlap): TargetSectionError => ({
        scope: 'target',
        target: overlap.longer,
        problem: `targets ${JSON.stringify(overlap.shorter)} and ${JSON.stringify(overlap.longer)} are both sprites targets, and the spritePrefix of ${JSON.stringify(overlap.longer)} starts with the spritePrefix of ${JSON.stringify(overlap.shorter)}; give each target a prefix that no other starts with, so a connector's access policy admits one target alone`,
      })),
    ],
  };
}
