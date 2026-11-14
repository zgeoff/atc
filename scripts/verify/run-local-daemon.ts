import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { buildStubTUIClaude, createStubBin, waitFor } from '@atc/test-utils';
import { buildLocalConfig } from './build-local-config.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';
import { readRunHome } from './read-run-home.ts';

// The `local` target's app. `with-test-home.sh` starts it in a new temp home, so the daemon, its
// sockets and its state database live there. It writes the stand-in claude and the config that
// points at it, starts `atc daemon`, and prints one JSON line once the daemon answers a hello.
export async function runLocalDaemon(env: Readonly<Record<string, string | undefined>>) {
  const home = readRunHome(env);
  const paths = resolvePaths(env);
  const stub = createStubBin(home.home, 'fake-claude', buildStubTUIClaude(home.cli));

  mkdirSync(join(home.home, '.config', 'atc'), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify(buildLocalConfig(home.home, stub)));

  // with-test-home.sh made the run's folder; it removes it and every process holding the run's
  // ATC_TEST_HOME once this process exits.
  const daemon = Bun.spawn([process.execPath, home.cli, 'daemon'], {
    env: { ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const stopDaemon = () => {
    daemon.kill('SIGTERM');
  };

  process.on('SIGTERM', stopDaemon);
  process.on('SIGINT', stopDaemon);

  const answered = await waitFor(() => openDaemonConnection(paths.daemonSocketPath), {
    timeoutMs: 30_000,
    intervalMs: 100,
  });

  answered[Symbol.dispose]();

  process.stdout.write(
    `${JSON.stringify({
      event: 'ready',
      root: home.root,
      home: home.home,
      stub,
      config: paths.configFile,
      socket: paths.daemonSocketPath,
      events: paths.eventsSocketPath,
      db: paths.dbFile,
    })}\n`,
  );

  process.exitCode = await daemon.exited;
}

if (import.meta.main) {
  await runLocalDaemon(process.env);
}
