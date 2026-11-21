import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildStubNpm } from './build-stub-npm';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-npm-');

  return { directory: temporaryDirectory.path };
}

test('it fails a view of a version the registry lacks with an E404 and exit code 1', async () => {
  const ctx = setupTest();

  const npm = createStubBin(ctx.directory, 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null),
  }).path;

  const viewed = await run([npm, 'view', '@atcx/contract@7.1.0', 'version']);

  expect({
    exitCode: viewed.exitCode,
    stdout: viewed.stdout,
    stderr: viewed.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'npm error code E404\nnpm error 404 No match found for version 7.1.0\n',
  });
});

test('it answers a view of a version the registry holds with that version', async () => {
  const ctx = setupTest();

  const npm = createStubBin(ctx.directory, 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), '7.1.0'),
  }).path;

  const viewed = await run([npm, 'view', '@atcx/contract@7.1.0', 'version']);

  expect({
    exitCode: viewed.exitCode,
    stdout: viewed.stdout,
    stderr: viewed.stderr,
  }).toStrictEqual({ exitCode: 0, stdout: '7.1.0\n', stderr: '' });
});

test('it succeeds at any other command with no output', async () => {
  const ctx = setupTest();

  const npm = createStubBin(ctx.directory, 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null),
  }).path;

  const published = await run([npm, 'publish', 'contract.tgz', '--access', 'public']);

  expect({
    exitCode: published.exitCode,
    stdout: published.stdout,
    stderr: published.stderr,
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it records the arguments of each call in order', async () => {
  const ctx = setupTest();

  const npm = createStubBin(ctx.directory, 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null),
  }).path;

  await run([npm, 'view', '@atcx/contract@7.1.0', 'version']);
  await run([npm, 'publish', 'contract.tgz', '--provenance']);

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe(
    'view @atcx/contract@7.1.0 version\npublish contract.tgz --provenance\n',
  );
});

test('it runs an install through the npm it is given, after it records the call', async () => {
  const ctx = setupTest();

  const installer = createStubBin(join(ctx.directory, 'real'), 'npm', {
    script: '#!/bin/sh\necho "installed $*"\nexit 3\n',
  }).path;

  const npm = createStubBin(ctx.directory, 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null, { installWith: installer }),
  }).path;

  const installed = await run([npm, 'install', '--prefix', 'consumer', 'contract.tgz']);

  expect({
    exitCode: installed.exitCode,
    stdout: installed.stdout,
    stderr: installed.stderr,
  }).toStrictEqual({
    exitCode: 3,
    stdout: 'installed install --prefix consumer contract.tgz\n',
    stderr: '',
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe(
    'install --prefix consumer contract.tgz\n',
  );
});

test('it runs a pack through the npm it is given, after it records the call', async () => {
  const ctx = setupTest();

  const packer = createStubBin(join(ctx.directory, 'real'), 'npm', {
    script: '#!/bin/sh\necho "packed $*"\nexit 4\n',
  }).path;

  const npm = createStubBin(ctx.directory, 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null, { installWith: packer }),
  }).path;

  const packed = await run([npm, 'pack', '--silent']);

  expect({ exitCode: packed.exitCode, stdout: packed.stdout }).toStrictEqual({
    exitCode: 4,
    stdout: 'packed pack --silent\n',
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe('pack --silent\n');
});
