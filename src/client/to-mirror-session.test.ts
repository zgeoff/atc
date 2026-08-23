import { expect, test } from 'bun:test';
import { toMirrorSession } from './to-mirror-session';

// A descriptor carrying every required field, so each test overrides only
// the one property its case is about.
function buildDescriptor(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
    ...overrides,
  };
}

test('it round-trips a gateway agent id instead of coercing it to claude', () => {
  const mirror = toMirrorSession(buildDescriptor({ agent: 'zai' }));

  if (mirror === null) {
    throw new Error('expected a mirror session');
  }

  expect(mirror.agent).toBe('zai');
});

test('it falls back lastAttachedAt to createdAt when the descriptor omits it', () => {
  const mirror = toMirrorSession(buildDescriptor({ createdAt: 4200 }));

  if (mirror === null) {
    throw new Error('expected a mirror session');
  }

  expect(mirror.lastAttachedAt).toBe(4200);
});

test('it falls back repoRoot to cwd when the descriptor omits it', () => {
  const mirror = toMirrorSession(buildDescriptor({ cwd: '/repo/nested' }));

  if (mirror === null) {
    throw new Error('expected a mirror session');
  }

  expect(mirror.repoRoot).toBe('/repo/nested');
});

test('it defaults kind to pty when the descriptor omits it', () => {
  const mirror = toMirrorSession(buildDescriptor());

  if (mirror === null) {
    throw new Error('expected a mirror session');
  }

  expect(mirror.kind).toBe('pty');
});

test('it returns null for a descriptor missing a required field, rather than throwing', () => {
  const { name: _name, ...withoutName } = buildDescriptor();
  let mirror: unknown = 'not called';

  expect(() => {
    mirror = toMirrorSession(withoutName);
  }).not.toThrow();

  expect(mirror).toBeNull();
});

// canEject is what keeps the H key on a row whose adapter can run a headless
// turn. A gateway session is a Claude binary under another id, so the flag —
// not the agent id — has to decide.
test('it keeps canEject when the descriptor sets it', () => {
  const mirror = toMirrorSession(buildDescriptor({ agent: 'zai', canEject: true }));

  if (mirror === null) {
    throw new Error('expected a mirror session');
  }

  expect(mirror.canEject).toBe(true);
});

test('it reports canEject as false when the descriptor omits it', () => {
  const mirror = toMirrorSession(buildDescriptor());

  if (mirror === null) {
    throw new Error('expected a mirror session');
  }

  expect(mirror.canEject).toBe(false);
});
