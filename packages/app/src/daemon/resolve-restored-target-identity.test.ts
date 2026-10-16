import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { buildTargetIdentity } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import { resolveRestoredTargetIdentity } from './resolve-restored-target-identity';
import { buildStubRestoreImpProvider } from './testing/build-stub-restore-imp-provider';

test('it restores a legacy binding once the provider confirms its imp exists', async () => {
  const provider = buildStubRestoreImpProvider();
  const entry = buildMockFleetEntry({ target: 'cloud', targetIdentity: 'imp:0123456789abcdef' });

  provider.createHost(entry.sessionID);

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: { image: 'new' },
    identity: buildTargetIdentity('imp', { image: 'new' }),
    provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(target.identity);
  expect(provider.checked).toStrictEqual([entry.sessionID]);
  expect(provider.prepared).toStrictEqual([]);
});

test('it refuses a legacy binding whose imp is gone without creating an imp', async () => {
  const provider = buildStubRestoreImpProvider();
  const entry = buildMockFleetEntry({ target: 'cloud', targetIdentity: 'imp:0123456789abcdef' });

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: { image: 'new' },
    identity: buildTargetIdentity('imp', { image: 'new' }),
    provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe('imp:0123456789abcdef');
  expect(provider.checked).toStrictEqual([entry.sessionID]);
  expect(provider.prepared).toStrictEqual([]);
});

test('it refuses a versioned binding to a different server even when an imp has the same name', async () => {
  const provider = buildStubRestoreImpProvider();

  const entry = buildMockFleetEntry({
    target: 'cloud',
    targetIdentity: buildTargetIdentity('imp', { url: 'http://server-a' }),
  });

  provider.createHost(entry.sessionID);

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: { url: 'http://server-b' },
    identity: buildTargetIdentity('imp', { url: 'http://server-b' }),
    provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(entry.targetIdentity);
  expect(provider.checked).toStrictEqual([]);
});

test('it checks the shared host of a legacy sub-session', async () => {
  const provider = buildStubRestoreImpProvider();

  const entry = buildMockFleetEntry({
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
    hostKey: toSessionID('parent-host'),
  });

  provider.createHost('parent-host');

  const target = {
    id: 'cloud',
    kind: 'imp',
    options: {},
    identity: buildTargetIdentity('imp', {}),
    provider,
  };

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(target.identity);
  expect(provider.checked).toStrictEqual(['parent-host']);
});
