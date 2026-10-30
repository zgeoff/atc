import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { createGatewayAdapter } from '@atc/harness-claude';
import { getGatewayConfig } from '@atc/harness-claude/testing';
import {
  buildMockHostServices,
  createGitFixture,
  createStubBin,
  createStubRecordingClaude,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-sub-session-trust-');
  const port = createStubImpPort();
  const fakeClaude = createStubRecordingClaude(temporaryDirectory.path);
  const guestATC = createStubBin(temporaryDirectory.path, 'atc', '#!/bin/sh\necho 1.0.0\n');
  const guestDir = join(temporaryDirectory.path, 'guest');
  const otherGuestDir = join(temporaryDirectory.path, 'other-guest');

  const box = createImpProvider(
    port,
    { guestDir, guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    box.dispose();
  });

  const otherBox = createImpProvider(
    port,
    { guestDir: otherGuestDir, guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    otherBox.dispose();
  });

  const daemon = await startTestDaemon({
    options: () => {
      const agents = parseConfig(SHIPPED_HARNESS_PLUGINS, {
        authProfiles: {
          glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        },
        agents: {
          glm: {
            kind: 'claude',
            bin: fakeClaude,
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: {
              profiles: ['glm'],
              placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
            },
          },
        },
      });

      return {
        adapters: [
          createGatewayAdapter(getGatewayConfig(agents, 'glm'), agents, buildMockHostServices()),
        ],
        gitTransports: ['file'],
        defaultTarget: 'box',
        targets: [
          { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: box },
          { id: 'other', kind: 'imp', options: {}, identity: 'imp:other', provider: otherBox },
        ],
      };
    },
  });

  return {
    directory: temporaryDirectory.path,
    guestDir,
    otherGuestDir,
    port,
    daemon,
  };
}

test('it trusts a sub-session in the clone root its parent trusts', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-sub-session-trust-git-' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const root = join(ctx.directory, 'clone');

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: root,
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: git.work },
  });

  const child = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'glm',
    target: 'box',
    parent: String(getRecord(parent, 'session')['id']),
  });

  const config = join(
    ctx.guestDir,
    'sessions',
    String(getRecord(child, 'session')['id']),
    'claude-config',
    '.claude.json',
  );

  await waitFor(() => {
    expect(existsSync(config)).toBeTrue();
  });

  expect(JSON.parse(readFileSync(config, 'utf8'))).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    projects: { [root]: { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
  });
});

test('it leaves a sub-session untrusted in a folder its parent does not trust', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-sub-session-trust-git-' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: join(ctx.directory, 'clone'),
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: git.work },
  });

  const child = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: git.work,
    agent: 'glm',
    target: 'box',
    parent: String(getRecord(parent, 'session')['id']),
  });

  const config = join(
    ctx.guestDir,
    'sessions',
    String(getRecord(child, 'session')['id']),
    'claude-config',
    '.claude.json',
  );

  await waitFor(() => {
    expect(existsSync(config)).toBeTrue();
  });

  expect(JSON.parse(readFileSync(config, 'utf8'))).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
  });
});

test('it leaves a sub-session untrusted in the clone of a parent that took no trust', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-sub-session-trust-git-' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const root = join(ctx.directory, 'clone');

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: git.work },
  });

  const child = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'glm',
    target: 'box',
    parent: String(getRecord(parent, 'session')['id']),
  });

  const config = join(
    ctx.guestDir,
    'sessions',
    String(getRecord(child, 'session')['id']),
    'claude-config',
    '.claude.json',
  );

  await waitFor(() => {
    expect(existsSync(config)).toBeTrue();
  });

  expect(JSON.parse(readFileSync(config, 'utf8'))).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
  });
});

test('it leaves a sub-session untrusted on another target at its parent trusted path', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-sub-session-trust-git-' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const root = join(ctx.directory, 'clone');

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: root,
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: git.work },
  });

  const child = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'glm',
    target: 'other',
    parent: String(getRecord(parent, 'session')['id']),
  });

  const config = join(
    ctx.otherGuestDir,
    'sessions',
    String(getRecord(child, 'session')['id']),
    'claude-config',
    '.claude.json',
  );

  await waitFor(() => {
    expect(existsSync(config)).toBeTrue();
  });

  expect(JSON.parse(readFileSync(config, 'utf8'))).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
  });
});
