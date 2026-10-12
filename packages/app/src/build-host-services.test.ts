import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getBuild } from '@atc/config/get-build';
import { systemClock } from '@atc/core/system-clock';
import { getSourceEntry } from '@atc/test-utils/get-source-entry';
import { z } from 'zod';
import { buildHostServices } from './build-host-services';

test('it runs the CLI entrypoint under bun from a source tree', () => {
  expect(buildHostServices().atcArgv).toStrictEqual([process.execPath, getSourceEntry('atc')]);
});

test("it reads the version from the app's manifest", () => {
  const appDir = dirname(dirname(getSourceEntry('atc')));
  const manifest: unknown = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));

  expect(manifest).toMatchObject({ version: buildHostServices().version });
});

test('it stamps the version with every workspace package src tree of the checkout', () => {
  const appDir = dirname(dirname(getSourceEntry('atc')));
  const repoDir = dirname(dirname(appDir));
  const text = readFileSync(join(repoDir, 'package.json'), 'utf8');
  const workspaces = z.object({ packages: z.array(z.string()) });
  const manifest = z.object({ workspaces }).parse(JSON.parse(text));

  const roots = manifest.workspaces.packages.flatMap((pattern) => {
    const glob = new Bun.Glob(`${pattern}/package.json`);

    const found = [...glob.scanSync({ cwd: repoDir, onlyFiles: true })];

    return found.map((path) => join(repoDir, dirname(path), 'src'));
  });

  const host = buildHostServices();

  expect(roots).toContain(join(repoDir, 'packages', 'harnesses', 'claude', 'src'));
  expect(host.build).toBe(getBuild({ version: host.version, roots }));
});

test('it runs a command on the machine and returns its exit code and trimmed output', async () => {
  const host = buildHostServices();

  const ran = await host.runCommand(['sh', '-c', 'echo out; echo err >&2; exit 3']);

  expect(ran).toStrictEqual({
    code: 3,
    stdout: 'out',
    stderr: 'err',
  });
});

test('it tells the time by the wall clock', () => {
  expect(buildHostServices().clock).toBe(systemClock);
});

test('it writes each log line through the log it is given', () => {
  const log = mock<(line: string) => void>();

  buildHostServices(log).log('daemon up');

  expect(log).toHaveBeenCalledExactlyOnceWith('daemon up');
});
