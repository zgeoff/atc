import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '@atc/core';
import { waitUntil } from '@atc/core';
import { readSessionEnv } from '@atc/protocol/session';
import { buildATCCommand } from './build-atc-command';
import { collectRestartEnv } from './collect-restart-env';
import { collectRestartPlan } from './collect-restart-plan';
import { formatRestartPreflight } from './format-restart-preflight';
import { isProcessAlive } from './is-process-alive';
import type { LifecycleHost } from './lifecycle-host';
import { parseRestartResult } from './parse-restart-result';
import { parseWorkerPID } from './parse-worker-pid';
import { spawnATCDetached } from './spawn-atc-detached';

interface DaemonRestartOptions {
  readonly listen: string | null;
  readonly tokenFile: string | null;
  readonly timeoutSeconds: number | null;
  readonly dryRun: boolean;
}

const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// How long the follower waits for the worker to report its pid before it
// gives up on a worker that never started.
const WORKER_START_WAIT_MS = 30_000;

// a restart hands the work to a detached worker because the restart can
// end the process that asked for it.
export async function runDaemonRestart(
  host: LifecycleHost,
  options: DaemonRestartOptions,
): Promise<number> {
  const clock = host.clock;
  const restartsDir = host.paths.restartsDir;
  const invocation = host.invocation;
  const callerSession = readSessionEnv(process.env).sessionID ?? null;

  const plan = await collectRestartPlan(host, callerSession);

  if (options.dryRun) {
    for (const line of formatRestartPreflight(plan)) {
      console.log(line);
    }

    return 0;
  }

  mkdirSync(restartsDir, { recursive: true });
  removeStaleRestartLogs(restartsDir, clock);

  const runID = mintRunID(clock);
  const logPath = join(restartsDir, `${runID}.log`);
  const workerArgs = buildWorkerArgs(runID, callerSession, options);
  const logFD = openSync(logPath, 'a');
  let workerPID: number | null = null;

  try {
    if (plan.replacement.kind === 'unit') {
      const started = await startWorkerInUnit(runID, logPath, invocation.argv, workerArgs);

      if (started !== 0) {
        console.error(`atc daemon restart: systemd-run failed with exit code ${started}`);

        return 1;
      }
    } else {
      workerPID =
        spawnATCDetached(invocation.argv, workerArgs, {
          env: collectRestartEnv(process.env),
          stdio: ['ignore', logFD, logFD],
        }).pid ?? null;
    }
  } finally {
    closeSync(logFD);
  }

  console.log(`progress: ${logPath}`);

  return printRunLog(runID, logPath, workerPID, clock);
}

function mintRunID(clock: Clock): string {
  return `${clock.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
}

function buildWorkerArgs(
  runID: string,
  callerSession: string | null,
  options: DaemonRestartOptions,
): string[] {
  return [
    'daemon',
    'restart-worker',
    runID,
    ...(callerSession === null ? [] : ['--session', callerSession]),
    ...(options.listen === null ? [] : ['--listen', options.listen]),
    ...(options.tokenFile === null ? [] : ['--token-file', options.tokenFile]),
    ...(options.timeoutSeconds === null ? [] : ['--timeout', String(options.timeoutSeconds)]),
  ];
}

// a unit restart stops the unit's whole cgroup, which holds a hosted caller,
// so the worker runs as its own transient unit, with its environment set
// explicitly, since the user manager's points at the real state directory.
function startWorkerInUnit(
  runID: string,
  logPath: string,
  atcArgv: readonly string[],
  workerArgs: readonly string[],
): Promise<number> {
  const env = collectRestartEnv(process.env);

  const setenvs = Object.entries(env)
    .filter(
      ([key]) =>
        key === 'HOME' || key === 'XDG_RUNTIME_DIR' || key === 'PATH' || key.startsWith('ATC_'),
    )
    .map(([key, value]) => `--setenv=${key}=${value}`);

  const proc = Bun.spawn(
    [
      'systemd-run',
      '--user',
      '--collect',
      '--quiet',
      '--unit',
      `atc-daemon-restart-${runID}`,
      `--property=StandardOutput=append:${logPath}`,
      `--property=StandardError=append:${logPath}`,
      ...setenvs,
      '--',
      ...buildATCCommand(atcArgv, workerArgs),
    ],
    { env, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' },
  );

  return proc.exited;
}

async function printRunLog(
  runID: string,
  logPath: string,
  workerPIDAtStart: number | null,
  clock: Clock,
): Promise<number> {
  const startedAt = clock.now();
  let workerPID = workerPIDAtStart;
  let printed = 0;
  let pending = '';
  let vanished = false;
  const settled: { code?: number } = {};

  await waitUntil(
    () => {
      const text = readLog(logPath);

      pending += text.slice(printed);
      printed = text.length;

      const lines = pending.split('\n');

      pending = lines.pop() ?? '';

      for (const line of lines) {
        const result = parseRestartResult(line);

        if (result !== null && result.runID === runID) {
          settled.code = result.code;

          return true;
        }

        const announced = parseWorkerPID(line);

        if (announced !== null) {
          workerPID = announced;
          continue;
        }

        console.log(line);
      }

      if (vanished) {
        settled.code = printVanishedWorker(logPath);

        return true;
      }

      // One more read after the worker is gone, in case its last lines
      // landed between the read above and its exit.
      vanished =
        (workerPID !== null && !isProcessAlive(workerPID)) ||
        (workerPID === null && clock.now() - startedAt > WORKER_START_WAIT_MS);

      return false;
    },
    { clock, intervalMs: 100, deadlineMs: Number.POSITIVE_INFINITY },
  );

  return settled.code ?? printVanishedWorker(logPath);
}

function printVanishedWorker(logPath: string): number {
  console.error(`atc daemon restart: the restart worker ended without a result; see ${logPath}`);

  return 1;
}

function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function removeStaleRestartLogs(restartsDir: string, clock: Clock): void {
  const cutoff = clock.now() - LOG_RETENTION_MS;

  for (const entry of readdirSync(restartsDir)) {
    if (!entry.endsWith('.log')) {
      continue;
    }

    const path = join(restartsDir, entry);

    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
      }
    } catch {}
  }
}
