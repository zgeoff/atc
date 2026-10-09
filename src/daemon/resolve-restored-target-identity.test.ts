import { expect, onTestFinished, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildMockImpIdentity } from '../test-utils/build-mock-imp-identity';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { buildTargetIdentity } from './build-target-identity';
import { ImpProvider } from './imp-provider';
import { resolveRestoredTargetIdentity } from './resolve-restored-target-identity';

function setupTest() {
  const port = createStubImpPort();

  const provider = new ImpProvider(port, {});

  onTestFinished(() => {
    provider.dispose();
  });

  return { port, provider };
}

test('it restores a legacy binding only when its imp exists under the current credentials', async () => {
  const ctx = setupTest();
  const entry = buildMockFleetEntry({ target: 'cloud', targetIdentity: 'imp:0123456789abcdef' });

  await ctx.port.createImp({ name: ctx.provider.getImpName(entry.sessionID) });

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: { image: 'new' },
    identity: buildTargetIdentity('imp', { image: 'new' }),
    provider: ctx.provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(target.identity);
  expect(ctx.port.createSpecs).toStrictEqual([{ name: ctx.provider.getImpName(entry.sessionID) }]);
});

test('it refuses a legacy binding whose imp is gone without creating an imp', async () => {
  const ctx = setupTest();
  const entry = buildMockFleetEntry({ target: 'cloud', targetIdentity: 'imp:0123456789abcdef' });

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: { image: 'new' },
    identity: buildTargetIdentity('imp', { image: 'new' }),
    provider: ctx.provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe('imp:0123456789abcdef');
  expect(ctx.port.createSpecs).toStrictEqual([]);
});

test('it refuses a versioned binding to a different server even when an imp has the same name', async () => {
  const ctx = setupTest();

  const entry = buildMockFleetEntry({
    target: 'cloud',
    targetIdentity: buildTargetIdentity('imp', { url: 'http://server-a' }),
  });

  await ctx.port.createImp({ name: ctx.provider.getImpName(entry.sessionID) });

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: { url: 'http://server-b' },
    identity: buildTargetIdentity('imp', { url: 'http://server-b' }),
    provider: ctx.provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(entry.targetIdentity);
  expect(ctx.port.calls).toStrictEqual([`imps.create ${ctx.provider.getImpName(entry.sessionID)}`]);
});

test('it refuses a legacy binding when current credentials cannot reach its imp', async () => {
  const ctx = setupTest();
  const entry = buildMockFleetEntry({ target: 'cloud', targetIdentity: 'imp:0123456789abcdef' });

  await ctx.port.createImp({ name: ctx.provider.getImpName(entry.sessionID) });

  ctx.port.setIdentity(buildMockImpIdentity({ imps: ['other-*'] }));

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: {},
    identity: buildTargetIdentity('imp', {}),
    provider: ctx.provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe('imp:0123456789abcdef');

  expect(ctx.port.calls).toStrictEqual([
    `imps.create ${ctx.provider.getImpName(entry.sessionID)}`,
    'tokens.whoami',
  ]);
});

test('it checks the shared host of a legacy sub-session', async () => {
  const ctx = setupTest();

  const entry = buildMockFleetEntry({
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
    hostKey: toSessionID('parent-host'),
  });

  await ctx.port.createImp({ name: ctx.provider.getImpName('parent-host') });

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: {},
    identity: buildTargetIdentity('imp', {}),
    provider: ctx.provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(target.identity);
});
