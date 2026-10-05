// Probes which environment a child launched by the daemon's own machine
// receives: a fresh Bun process starts with only synthetic marker variables,
// changes some of them at runtime, builds the clean map atc hands a harness,
// and launches `env` through the local PTY provider, `Bun.spawn`, and
// `node:child_process`. It prints, per marker, the startup value, the map's
// value, and what each child printed, and exits 1 when a marker the map left
// out still reaches a child. Values outside the marker set are never printed,
// only their names.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPTYProvider } from '../src/daemon/local-pty-provider';
import { collectCleanEnv } from '../src/shared/collect-clean-env';
import { isRecord } from '../src/shared/report';

const INNER_FLAG = '--inner';

// Every value is synthetic. The parent-session keys stand in for an
// enclosing Claude or Grok session, which the clean map drops.
const STARTUP_MARKERS: Readonly<Record<string, string>> = {
  ATC_PROBE_STARTUP_KEPT: 'startup',
  ATC_PROBE_STARTUP_WITHHELD: 'startup',
  ATC_PROBE_STARTUP_DELETED: 'startup',
  ATC_PROBE_STARTUP_OVERRIDDEN: 'startup',
  ATC_PROBE_STARTUP_CHANGED: 'startup',
  ATC_PROBE_STARTUP_CHANGED_WITHHELD: 'startup',
  CLAUDECODE: 'atc-probe-startup',
  CLAUDE_CODE_ATC_PROBE: 'atc-probe-startup',
  GROK_SESSION_ID: 'atc-probe-startup',
};

const RUNTIME_SETS: Readonly<Record<string, string>> = {
  ATC_PROBE_RUNTIME_ADDED: 'runtime',
  ATC_PROBE_RUNTIME_WITHHELD: 'runtime',
  ATC_PROBE_STARTUP_CHANGED: 'runtime',
  ATC_PROBE_STARTUP_CHANGED_WITHHELD: 'runtime',
};

const RUNTIME_DELETES: readonly string[] = ['ATC_PROBE_STARTUP_DELETED'];

const MAP_EXTRAS: Readonly<Record<string, string>> = {
  ATC_PROBE_MAP_ONLY: 'map',
  ATC_PROBE_STARTUP_OVERRIDDEN: 'map',
};

const WITHHELD: readonly string[] = [
  'ATC_PROBE_STARTUP_WITHHELD',
  'ATC_PROBE_RUNTIME_WITHHELD',
  'ATC_PROBE_STARTUP_CHANGED_WITHHELD',
];

const MARKER_KEYS: readonly string[] = [
  ...new Set([
    ...Object.keys(STARTUP_MARKERS),
    ...Object.keys(RUNTIME_SETS),
    ...Object.keys(MAP_EXTRAS),
  ]),
].toSorted();

const ENV_BIN = '/usr/bin/env';
const runProbe = process.argv.includes(INNER_FLAG) ? runInnerProbe : main;

await runProbe();

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'atc-probe-pty-env-'));

  try {
    const proc = Bun.spawn([process.execPath, import.meta.path, INNER_FLAG], {
      cwd: home,
      env: { PATH: '/usr/bin:/bin', HOME: home, ...STARTUP_MARKERS },
      stdout: 'pipe',
      stderr: 'inherit',
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    if (exitCode !== 0) {
      throw new Error(`the probe process exited ${exitCode}`);
    }

    const report = parseInnerReport(stdout);

    printReport(report);

    process.exitCode = report.inherited.length === 0 ? 0 : 1;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

interface ChildEnv {
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
}

interface InnerReport {
  readonly platform: string;
  readonly bun: string;
  readonly bunPTY: string;
  readonly startupKeys: readonly string[];
  readonly startup: Readonly<Record<string, string>>;
  readonly runtime: Readonly<Record<string, string>>;
  readonly map: Readonly<Record<string, string>>;
  readonly mapKeys: readonly string[];
  readonly children: readonly ChildEnv[];
  readonly inherited: readonly string[];
}

function parseInnerReport(stdout: string): InnerReport {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the probe process writes this shape
  return JSON.parse(stdout) as InnerReport;
}

function printReport(report: InnerReport): void {
  console.log(`platform: ${report.platform}`);
  console.log(`bun: ${report.bun}`);
  console.log(`bun-pty: ${report.bunPTY}`);
  console.log(`probe process startup keys: ${report.startupKeys.join(' ')}`);
  console.log(`runtime sets: ${Object.keys(RUNTIME_SETS).join(' ')}`);
  console.log(`runtime deletes: ${RUNTIME_DELETES.join(' ')}`);
  console.log(`withheld: ${WITHHELD.join(' ')}`);
  console.log(`map keys: ${report.mapKeys.join(' ')}`);
  console.log('');

  const header = ['marker', 'startup', 'process.env', 'map', ...report.children.map((c) => c.path)];

  const rows = MARKER_KEYS.map((key) => [
    key,
    report.startup[key] ?? '-',
    report.runtime[key] ?? '-',
    report.map[key] ?? '-',
    ...report.children.map((c) => c.env[key] ?? '-'),
  ]);

  for (const row of [header, ...rows]) {
    console.log(formatRow(row, [header, ...rows]));
  }

  console.log('');

  for (const child of report.children) {
    const extra = Object.keys(child.env)
      .filter((key) => !report.mapKeys.includes(key))
      .toSorted();

    const missing = report.mapKeys.filter((key) => child.env[key] === undefined);

    console.log(`${child.path}: keys not in the map: ${extra.join(' ') || '(none)'}`);
    console.log(`${child.path}: map keys missing: ${missing.join(' ') || '(none)'}`);
  }

  const verdict =
    report.inherited.length === 0
      ? 'no marker left out of the map reached a child'
      : `markers left out of the map reached a child: ${report.inherited.join(', ')}`;

  console.log('');
  console.log(`verdict: ${verdict}`);
}

function formatRow(row: readonly string[], all: readonly (readonly string[])[]): string {
  return row
    .map((cell, i) => cell.padEnd(Math.max(...all.map((r) => (r[i] ?? '').length))))
    .join('  ')
    .trimEnd();
}

async function runInnerProbe(): Promise<void> {
  const startupKeys = Object.keys(process.env).toSorted();
  const startup = collectMarkers(process.env);

  for (const [key, value] of Object.entries(RUNTIME_SETS)) {
    process.env[key] = value;
  }

  for (const key of RUNTIME_DELETES) {
    delete process.env[key];
  }

  const runtime = collectMarkers(process.env);
  const map = collectCleanEnv(MAP_EXTRAS, WITHHELD);

  const children: ChildEnv[] = [
    { path: 'local-pty', env: await readLocalPTYEnv(map) },
    { path: 'Bun.spawn', env: await readBunSpawnEnv(map) },
    { path: 'child_process', env: await readChildProcessEnv(map) },
  ];

  const inherited = children.flatMap((child) =>
    MARKER_KEYS.filter((key) => map[key] === undefined && child.env[key] !== undefined).map(
      (key) => `${key} (${child.path})`,
    ),
  );

  const pkg: unknown = await Bun.file(
    Bun.resolveSync('bun-pty/package.json', import.meta.dir),
  ).json();

  const report: InnerReport = {
    platform: `${process.platform} ${release()} ${arch()}`,
    bun: `${Bun.version} (${Bun.revision})`,
    bunPTY: isRecord(pkg) && typeof pkg['version'] === 'string' ? pkg['version'] : 'unknown',
    startupKeys,
    startup,
    runtime,
    map: collectMarkers(map),
    mapKeys: Object.keys(map).toSorted(),
    children: children.map((c) => ({ path: c.path, env: buildRedactedEnv(c.env) })),
    inherited,
  };

  console.log(JSON.stringify(report));
}

function collectMarkers(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const markers: Record<string, string> = {};

  for (const key of MARKER_KEYS) {
    const value = env[key];

    if (value !== undefined) {
      markers[key] = value;
    }
  }

  return markers;
}

// Keys outside the marker set keep their names with the value dropped, so
// the report shows which keys a child got without echoing their values.
function buildRedactedEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, MARKER_KEYS.includes(key) ? value : '<set>']),
  );
}

// The provider the daemon starts every local harness through, with the
// same map and withheld names it builds from a session's spec.
async function readLocalPTYEnv(
  map: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const provider = new LocalPTYProvider();

  const handle = provider.spawnHarness({
    session: 'atc-probe',
    host: 'atc-probe',
    bin: ENV_BIN,
    args: [],
    cwd: process.cwd(),
    env: MAP_EXTRAS,
    withheldEnv: WITHHELD,
    cols: 200,
    rows: 50,
  });

  let output = '';

  handle.onData((data) => {
    output += data;
  });

  const exited = await handle.waitForExit(10_000);

  if (!exited) {
    handle.kill();
    throw new Error('the local-pty child did not exit');
  }

  // The read loop can deliver the last chunk after the process is reaped.
  await Bun.sleep(200);

  handle.detach();

  const env = parseEnvOutput(output);

  assertSameKeys(env, map, 'local-pty');

  return env;
}

async function readBunSpawnEnv(
  map: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const proc = Bun.spawn([ENV_BIN], { env: { ...map }, stdout: 'pipe', stderr: 'inherit' });

  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  return parseEnvOutput(stdout);
}

async function readChildProcessEnv(
  map: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const child = spawn(ENV_BIN, [], { env: { ...map }, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';

  child.stdout.setEncoding('utf8');

  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);

    child.on('close', () => {
      resolve();
    });
  });

  return parseEnvOutput(stdout);
}

function parseEnvOutput(output: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf('=');

    if (eq > 0) {
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }

  return env;
}

// Every key the map holds must reach the child, so a short read of the PTY
// output fails the probe instead of passing as a missing key.
function assertSameKeys(
  env: Readonly<Record<string, string>>,
  map: Readonly<Record<string, string>>,
  path: string,
): void {
  const missing = Object.keys(map).filter((key) => env[key] === undefined);

  if (missing.length > 0) {
    throw new Error(`${path} child output lacks map keys ${missing.join(', ')}`);
  }
}
