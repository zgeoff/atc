import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { buildTargetIdentity } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubRestoreImpProvider } from '../testing/build-stub-restore-imp-provider';
import { resolveRestoredTargetIdentity } from './resolve-restored-target-identity';

test('it restores a legacy binding once the provider confirms its imp exists', async () => {
  const provider = buildStubRestoreImpProvider();
  const entry = buildMockFleetEntry({ target: 'cloud', targetIdentity: 'imp:0123456789abcdef' });

  provider.createHost(entry.sessionID);

  const target = buildMockExecutionTarget({
    id: 'cloud',
    kind: 'imp',
    options: { image: 'new' },
    identity: buildTargetIdentity(
      'imp',
      { image: 'new' },
      { version: 'reach-v1', ignoredOptions: ['image'] },
    ),
    identityRule: { version: 'reach-v1', ignoredOptions: ['image'] },
    provider,
  });

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(target.identity);
  expect(provider.checked).toStrictEqual([entry.sessionID]);
  expect(provider.prepared).toStrictEqual([]);
});

test('it refuses a legacy binding whose imp is gone without creating an imp', async () => {
  const provider = buildStubRestoreImpProvider();
  const entry = buildMockFleetEntry({ target: 'cloud', targetIdentity: 'imp:0123456789abcdef' });

  const target = buildMockExecutionTarget({
    id: 'cloud',
    kind: 'imp',
    options: { image: 'new' },
    identity: buildTargetIdentity(
      'imp',
      { image: 'new' },
      { version: 'reach-v1', ignoredOptions: ['image'] },
    ),
    identityRule: { version: 'reach-v1', ignoredOptions: ['image'] },
    provider,
  });

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe('imp:0123456789abcdef');
  expect(provider.checked).toStrictEqual([entry.sessionID]);
  expect(provider.prepared).toStrictEqual([]);
});

test('it refuses a versioned binding to a different server even when an imp has the same name', async () => {
  const provider = buildStubRestoreImpProvider();

  const entry = buildMockFleetEntry({
    target: 'cloud',
    targetIdentity: buildTargetIdentity(
      'imp',
      { url: 'http://server-a' },
      { version: 'reach-v1', ignoredOptions: [] },
    ),
  });

  provider.createHost(entry.sessionID);

  const target = buildMockExecutionTarget({
    id: 'cloud',
    kind: 'imp',
    options: { url: 'http://server-b' },
    identity: buildTargetIdentity(
      'imp',
      { url: 'http://server-b' },
      { version: 'reach-v1', ignoredOptions: [] },
    ),
    identityRule: { version: 'reach-v1', ignoredOptions: [] },
    provider,
  });

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

  const target = buildMockExecutionTarget({
    id: 'cloud',
    kind: 'imp',
    options: {},
    identity: buildTargetIdentity('imp', {}, { version: 'reach-v1', ignoredOptions: [] }),
    identityRule: { version: 'reach-v1', ignoredOptions: [] },
    provider,
  });

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(target.identity);
  expect(provider.checked).toStrictEqual(['parent-host']);
});

test('it confirms an unversioned binding on any kind whose plugin declares an identity rule', async () => {
  const provider = buildStubRestoreImpProvider();
  const entry = buildMockFleetEntry({ target: 'far', targetIdentity: 'cloud:0123456789abcdef' });

  provider.createHost(entry.sessionID);

  const target = buildMockExecutionTarget({
    id: 'far',
    kind: 'cloud',
    options: {},
    identity: buildTargetIdentity('cloud', {}, { version: 'reach-v2', ignoredOptions: [] }),
    identityRule: { version: 'reach-v2', ignoredOptions: [] },
    provider,
  });

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe(target.identity);
  expect(provider.checked).toStrictEqual([entry.sessionID]);
});

test('it leaves an unversioned binding unchecked on a kind whose plugin declares no identity rule', async () => {
  const provider = buildStubRestoreImpProvider();
  const entry = buildMockFleetEntry({ target: 'far', targetIdentity: 'cloud:0123456789abcdef' });

  provider.createHost(entry.sessionID);

  const target = buildMockExecutionTarget({
    id: 'far',
    kind: 'cloud',
    options: { region: 'north' },
    identity: buildTargetIdentity('cloud', { region: 'north' }),
    provider,
  });

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe('cloud:0123456789abcdef');
  expect(provider.checked).toStrictEqual([]);
});

test('it leaves an unversioned binding of another kind unchecked', async () => {
  const provider = buildStubRestoreImpProvider();
  const entry = buildMockFleetEntry({ target: 'far', targetIdentity: 'other:0123456789abcdef' });

  provider.createHost(entry.sessionID);

  const target = buildMockExecutionTarget({
    id: 'far',
    kind: 'cloud',
    options: {},
    identity: buildTargetIdentity('cloud', {}, { version: 'reach-v2', ignoredOptions: [] }),
    identityRule: { version: 'reach-v2', ignoredOptions: [] },
    provider,
  });

  const identity = await resolveRestoredTargetIdentity(target, entry);

  expect(identity).toBe('other:0123456789abcdef');
  expect(provider.checked).toStrictEqual([]);
});
