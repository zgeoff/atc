import type { TargetConfig } from './collect-targets';
import { DEFAULT_SPRITE_PREFIX } from './default-sprite-prefix';

interface SpritePrefixOverlap {
  readonly shorter: string;
  readonly longer: string;
}

// A connector's access policy admits every sprite whose name starts with the allowed prefix, so
// a target whose prefix extends another target's prefix would also use that target's connectors.
export function collectSpritePrefixOverlaps(
  targets: readonly TargetConfig[],
): readonly SpritePrefixOverlap[] {
  const prefixes = targets.flatMap((target) => {
    if (target.provider !== 'sprites') {
      return [];
    }

    const prefix = target.options['spritePrefix'] ?? DEFAULT_SPRITE_PREFIX;

    return typeof prefix === 'string' ? [{ id: target.id, prefix }] : [];
  });

  const overlaps: SpritePrefixOverlap[] = [];

  for (const [index, first] of prefixes.entries()) {
    for (const second of prefixes.slice(index + 1)) {
      if (second.prefix.startsWith(first.prefix)) {
        overlaps.push({ shorter: first.id, longer: second.id });
      } else if (first.prefix.startsWith(second.prefix)) {
        overlaps.push({ shorter: second.id, longer: first.id });
      }
    }
  }

  return overlaps;
}
