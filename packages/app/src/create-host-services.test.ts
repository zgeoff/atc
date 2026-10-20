import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readBuild } from '@atc/config/host';
import { systemClock } from '@atc/core';
import { readSourceEntry } from '@atc/test-utils';
import { z } from 'zod';
import { createHostServices } from './create-host-services';

test('it runs the CLI entrypoint under bun from a source tree', () => {
  expect(createHostServices().atcArgv).toStrictEqual([process.execPath, readSourceEntry('atc')]);
});

test('it runs the binary itself as the CLI entry inside a compiled binary', () => {
  expect(createHostServices({ compiled: true }).atcArgv).toStrictEqual([process.execPath]);
});

test("it reads the version from the app's manifest", () => {
  const appDir = dirname(dirname(readSourceEntry('atc')));
  const manifest: unknown = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));

  expect(manifest).toMatchObject({ version: createHostServices().version });
});

test('it stamps the version with every workspace package src tree of the checkout', () => {
  const appDir = dirname(dirname(readSourceEntry('atc')));
  const repoDir = dirname(dirname(appDir));
  const text = readFileSync(join(repoDir, 'package.json'), 'utf8');
  const workspaces = z.object({ packages: z.array(z.string()) });
  const manifest = z.object({ workspaces }).parse(JSON.parse(text));

  const roots = manifest.workspaces.packages.flatMap((pattern) => {
    const glob = new Bun.Glob(`${pattern}/package.json`);

    const found = [...glob.scanSync({ cwd: repoDir, onlyFiles: true })];

    return found.map((path) => join(repoDir, dirname(path), 'src'));
  });

  const host = createHostServices();

  expect(roots).toContain(join(repoDir, 'packages', 'harnesses', 'claude', 'src'));
  expect(host.build).toBe(readBuild({ version: host.version, roots }));
});

test('it runs a command on the machine and returns its exit code and trimmed output', async () => {
  const host = createHostServices();

  const ran = await host.runCommand(['sh', '-c', 'echo out; echo err >&2; exit 3']);

  expect(ran).toStrictEqual({
    code: 3,
    stdout: 'out',
    stderr: 'err',
    aborted: false,
  });
});

test('it tells the time by the wall clock', () => {
  expect(createHostServices().clock).toBe(systemClock);
});

test('it writes each log line through the log it is given', () => {
  const log = mock<(line: string) => void>();

  createHostServices({ log }).log('daemon up');

  expect(log).toHaveBeenCalledExactlyOnceWith('daemon up');
});
