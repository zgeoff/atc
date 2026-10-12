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
import { collectRestartEnv } from './collect-restart-env';
import { collectRestartPlan } from './collect-restart-plan';
import { formatRestartPreflight } from './format-restart-preflight';
import { parseRestartResult } from './parse-restart-result';
import { buildATCCommand } from './shared/build-atc-command';
import { restartsDir } from './shared/config';
import { isProcessAlive } from './shared/is-process-alive';
import { spawnATCDetached } from './shared/spawn-atc-detached';

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

/**
 * Runs `atc daemon restart` in the caller: a dry run prints the preflight
 * and stops, and a restart hands the work to a detached worker, because the
 * restart can end the process that asked for it. The worker writes a run
 * log, which this follows line by line until the worker's result record
 * ends it. Resolves the exit code: the worker's, or 1 when the worker
 * vanishes without a result.
 */
export async function runDaemonRestart(options: DaemonRestartOptions): Promise<number> {
  const callerSession = process.env['ATC_SESSION_ID'] ?? null;

  const plan = await collectRestartPlan(callerSession);

  if (options.dryRun) {
    for (const line of formatRestartPreflight(plan)) {
      console.log(line);
    }

    return 0;
  }

  mkdirSync(restartsDir, { recursive: true });
  removeStaleRestartLogs();

  const runID = mintRunID();
  const logPath = join(restartsDir, `${runID}.log`);
  const workerArgs = buildWorkerArgs(runID, callerSession, options);
  const logFD = openSync(logPath, 'a');
  let workerPID: number | null = null;

  try {
    if (plan.replacement.kind === 'unit') {
      const started = await startWorkerInUnit(runID, logPath, workerArgs);

      if (started !== 0) {
        console.error(`atc daemon restart: systemd-run failed with exit code ${started}`);

        return 1;
      }
    } else {
      workerPID =
        spawnATCDetached(workerArgs, {
          env: collectRestartEnv(process.env),
          stdio: ['ignore', logFD, logFD],
        }).pid ?? null;
    }
  } finally {
    closeSync(logFD);
  }

  console.log(`progress: ${logPath}`);

  return printRunLog(runID, logPath, workerPID);
}

function mintRunID(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
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

// A restart through a unit stops the unit's whole cgroup, which holds a
// hosted caller and its children, so the worker starts as a transient unit
// of its own. It gets HOME, XDG_RUNTIME_DIR, PATH and every ATC_ variable
// explicitly, since a transient unit otherwise inherits the user manager's
// environment and with it the real state directory.
function startWorkerInUnit(
  runID: string,
  logPath: string,
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
      ...buildATCCommand(workerArgs),
    ],
    { env, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' },
  );

  return proc.exited;
}

async function printRunLog(
  runID: string,
  logPath: string,
  workerPIDAtStart: number | null,
): Promise<number> {
  const startedAt = Date.now();
  let workerPID = workerPIDAtStart;
  let printed = 0;
  let pending = '';
  let vanished = false;

  for (;;) {
    const text = readLog(logPath);

    pending += text.slice(printed);
    printed = text.length;

    const lines = pending.split('\n');

    pending = lines.pop() ?? '';

    for (const line of lines) {
      const result = parseRestartResult(line);

      if (result !== null && result.runID === runID) {
        return result.code;
      }

      const pidMatch = /^worker pid (?<pid>\d+)$/.exec(line);

      if (pidMatch !== null) {
        workerPID = Number(pidMatch.groups?.['pid']);
      }

      console.log(line);
    }

    if (vanished) {
      return printVanishedWorker(logPath);
    }

    // One more read after the worker is gone, in case its last lines landed
    // between the read above and its exit.
    vanished =
      (workerPID !== null && !isProcessAlive(workerPID)) ||
      (workerPID === null && Date.now() - startedAt > WORKER_START_WAIT_MS);

    await Bun.sleep(100);
  }
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

function removeStaleRestartLogs(): void {
  const cutoff = Date.now() - LOG_RETENTION_MS;

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
