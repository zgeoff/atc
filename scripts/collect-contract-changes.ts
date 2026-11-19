import { isRecord } from '@atc/core';

// What the check reads from one release of the contract: the JSON Schema of each procedure's input
// and answer, and of the event. A schema that JSON Schema cannot hold, such as the event stream's
// answer, is null and the check skips it.
export interface ContractSchemas {
  readonly procedures: Readonly<
    Record<string, { readonly input: unknown; readonly output: unknown }>
  >;
  readonly event: unknown;
}

export interface ContractChange {
  // 'breaking' is a change that the additive rule marks "no". 'new-input-field' is an optional
  // input field that a release adds, which needs an entry in one of the two lists.
  readonly kind: 'breaking' | 'new-input-field';
  readonly method: string;
  readonly path: string;
  readonly message: string;
}

const EVENT = 'event';
const HELLO = 'daemon.hello';

export function collectContractChanges(
  before: ContractSchemas,
  after: ContractSchemas,
): ContractChange[] {
  const changes: ContractChange[] = [];

  for (const [method, old] of Object.entries(before.procedures)) {
    const current = after.procedures[method];

    if (current === undefined) {
      changes.push({
        kind: 'breaking',
        method,
        path: '',
        message: `the procedure ${method} is removed or renamed`,
      });

      continue;
    }

    // A release that made the hello strict adds its fields in the same change: a daemon that
    // dropped an unknown field in silence had nothing to refuse.
    if (method !== HELLO || isStrictObject(old.input)) {
      compareSchemas(old.input, current.input, [], { direction: 'input', method, changes });
    }

    compareSchemas(old.output, current.output, [], { direction: 'output', method, changes });
  }

  compareSchemas(before.event, after.event, [], {
    direction: 'output',
    method: EVENT,
    changes,
  });

  return changes;
}

function isStrictObject(schema: unknown): boolean {
  return isRecord(schema) && schema['additionalProperties'] === false;
}

type Direction = 'input' | 'output';

interface Walk {
  readonly direction: Direction;
  readonly method: string;
  readonly changes: ContractChange[];
}

function compareSchemas(
  before: unknown,
  after: unknown,
  path: readonly string[],
  walk: Walk,
): void {
  if (!isRecord(before) || !isRecord(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after) && before !== null && after !== null) {
      addBreaking(walk, path, 'the schema changed shape');
    }

    return;
  }

  compareTypes(before, after, path, walk);
  compareValues(before, after, path, walk);
  compareBounds(before, after, path, walk);
  compareProperties(before, after, path, walk);
  compareVariants(before, after, path, walk);

  if (before['items'] !== undefined && after['items'] !== undefined) {
    compareSchemas(before['items'], after['items'], path, walk);
  }
}

function addBreaking(walk: Walk, path: readonly string[], message: string): void {
  walk.changes.push({
    kind: 'breaking',
    method: walk.method,
    path: path.join('.'),
    message: `${walk.direction === 'input' ? 'input' : 'answer'}: ${message}`,
  });
}

function compareTypes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: readonly string[],
  walk: Walk,
): void {
  const old = toTypeSet(before['type']);
  const current = toTypeSet(after['type']);

  const isCompatible =
    walk.direction === 'input' ? isSetCovering(current, old) : isSetCovering(old, current);

  if (!isCompatible) {
    addBreaking(walk, path, 'the type changed or narrowed');
  }
}

function toTypeSet(type: unknown): ReadonlySet<string> | null {
  if (typeof type === 'string') {
    return new Set([type]);
  }

  return Array.isArray(type) ? new Set(toStringList(type)) : null;
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

// A null set holds every value, so it covers any set, and only a null set covers a null set.
function isSetCovering(
  wide: ReadonlySet<string> | null,
  narrow: ReadonlySet<string> | null,
): boolean {
  if (wide === null) {
    return true;
  }

  if (narrow === null) {
    return false;
  }

  return [...narrow].every((value) => wide.has(value));
}

function compareValues(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: readonly string[],
  walk: Walk,
): void {
  // A value that an enum loses breaks an answer too: an older daemon still returns it, and a newer
  // client may have narrowed its types.
  if (!isSetCovering(toValueSet(after), toValueSet(before))) {
    const message =
      walk.direction === 'input' ? 'an accepted value is removed' : 'an answer value is removed';

    addBreaking(walk, path, message);
  }

  if (walk.direction === 'output') {
    return;
  }

  for (const key of ['pattern', 'format']) {
    if (before[key] !== after[key] && after[key] !== undefined) {
      addBreaking(walk, path, `the ${key} changed or narrowed`);
    }
  }
}

function toValueSet(schema: Record<string, unknown>): ReadonlySet<string> | null {
  const values = schema['enum'];

  if (Array.isArray(values)) {
    return new Set(values.map((value) => JSON.stringify(value)));
  }

  return schema['const'] === undefined ? null : new Set([JSON.stringify(schema['const'])]);
}

const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'];
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'];

function compareBounds(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: readonly string[],
  walk: Walk,
): void {
  if (walk.direction === 'output') {
    return;
  }

  for (const key of LOWER_BOUNDS) {
    if (isNarrower(before[key], after[key], 'lower')) {
      addBreaking(walk, path, `${key} narrowed`);
    }
  }

  for (const key of UPPER_BOUNDS) {
    if (isNarrower(before[key], after[key], 'upper')) {
      addBreaking(walk, path, `${key} narrowed`);
    }
  }

  if (before['additionalProperties'] !== false && after['additionalProperties'] === false) {
    addBreaking(walk, path, 'the object refuses fields it took before');
  }
}

function isNarrower(before: unknown, after: unknown, side: 'lower' | 'upper'): boolean {
  if (typeof after !== 'number') {
    return false;
  }

  if (typeof before !== 'number') {
    return true;
  }

  return side === 'lower' ? after > before : after < before;
}

function compareProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: readonly string[],
  walk: Walk,
): void {
  const oldProperties = isRecord(before['properties']) ? before['properties'] : {};
  const newProperties = isRecord(after['properties']) ? after['properties'] : {};
  const oldRequired = toStringList(before['required']);
  const newRequired = toStringList(after['required']);

  for (const [key, schema] of Object.entries(oldProperties)) {
    const fieldPath = [...path, key];
    const current = newProperties[key];

    if (current === undefined) {
      addBreaking(walk, fieldPath, 'the field is removed or renamed');
      continue;
    }

    compareSchemas(schema, current, fieldPath, walk);

    if (walk.direction === 'input' && newRequired.includes(key) && !oldRequired.includes(key)) {
      addBreaking(walk, fieldPath, 'the field is required now');
    }

    if (walk.direction === 'output' && oldRequired.includes(key) && !newRequired.includes(key)) {
      addBreaking(walk, fieldPath, 'the field is optional now');
    }
  }

  for (const key of Object.keys(newProperties)) {
    if (oldProperties[key] !== undefined) {
      continue;
    }

    const fieldPath = [...path, key];

    if (newRequired.includes(key)) {
      // A newer client could rely on an answer field that an older daemon never sends.
      addBreaking(walk, fieldPath, 'the new field is required');
    } else if (walk.method === HELLO && walk.direction === 'input') {
      // The hello schema is strict, so an older daemon refuses a hello that carries the field.
      addBreaking(walk, fieldPath, 'the new field is refused by an older daemon');
    } else if (walk.direction === 'input') {
      walk.changes.push({
        kind: 'new-input-field',
        method: walk.method,
        path: fieldPath.join('.'),
        message: 'a new input field',
      });
    }
  }
}

function compareVariants(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: readonly string[],
  walk: Walk,
): void {
  const oldVariants = readVariants(before);
  const newVariants = readVariants(after);

  if (oldVariants === null && newVariants === null) {
    return;
  }

  if (oldVariants === null || newVariants === null) {
    addBreaking(walk, path, 'the schema changed between a union and a single shape');

    return;
  }

  const keyed = new Map(
    newVariants.map((variant, index) => [pickVariantKey(variant, index), variant]),
  );

  for (const [index, variant] of oldVariants.entries()) {
    const key = pickVariantKey(variant, index);
    const current = keyed.get(key);

    if (current === undefined) {
      if (walk.direction === 'input' || !key.startsWith('#')) {
        addBreaking(walk, path, `the union variant ${key} is removed`);
      }

      continue;
    }

    compareSchemas(variant, current, path, walk);
  }
}

function readVariants(schema: Record<string, unknown>): unknown[] | null {
  const variants = schema['anyOf'] ?? schema['oneOf'];

  return Array.isArray(variants) ? variants : null;
}

// A variant with a constant property, such as an event's kind, is named by it; any other variant
// is named by its place.
function pickVariantKey(variant: unknown, index: number): string {
  if (isRecord(variant) && isRecord(variant['properties'])) {
    for (const [name, property] of Object.entries(variant['properties'])) {
      if (isRecord(property) && property['const'] !== undefined) {
        return `${name}=${JSON.stringify(property['const'])}`;
      }
    }
  }

  return `#${index}`;
}
