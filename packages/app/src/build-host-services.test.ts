import { expect, mock, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getBuild } from '@atc/config/get-build';
import { systemClock } from '@atc/core/system-clock';
import { getSourceEntry } from '@atc/test-utils/get-source-entry';
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
  const packagesDir = dirname(appDir);
  const roots = readdirSync(packagesDir).map((name) => join(packagesDir, name, 'src'));
  const host = buildHostServices();

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
