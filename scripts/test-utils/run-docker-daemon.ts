import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createStandInImage } from '@atc/execution-docker/test-utils/create-stand-in-image';
import { readDockerLines } from '@atc/execution-docker/test-utils/read-docker-lines';
import { runDocker } from '@atc/execution-docker/test-utils/run-docker';
import { dockerTokenValue } from '../verify/constants.ts';
import { openDaemonConnection } from '../verify/open-daemon-connection.ts';
import { readRunHome } from '../verify/read-run-home.ts';

type Env = Readonly<Record<string, string | undefined>>;

// The `docker` target's app, started by `with-test-home.sh`: a compiled daemon, since a container
// runs its binary, with one docker target on an image that holds the stand-in claude. It removes
// the run's docker objects when it stops.
export async function runDockerDaemon(env: Env) {
  const home = readRunHome(env);
  const paths = resolvePaths(env);
  const prefix = `atcverify${Math.random().toString(36).slice(2, 8)}-`;
  const image = `${prefix}image`;
  const signIn = `${prefix}sign-in`;
  const binary = join(home.root, 'atc');

  const removeDockerObjects = async () => {
    const containers = await readDockerLines('ps', '-aq', '--filter', `name=${prefix}`);

    if (containers.length > 0) {
      await runDocker('rm', '-f', ...containers);
    }

    const volumes = await readDockerLines('volume', 'ls', '-q', '--filter', `name=${prefix}`);

    if (volumes.length > 0) {
      await runDocker('volume', 'rm', '-f', ...volumes);
    }

    await runDocker('rmi', '-f', image);
  };

  await runCompile(home.cli, binary);
  await createStandInImage(home.root, image);
  await runDocker('volume', 'create', signIn);

  await runDocker(
    'run',
    '--rm',
    '--user',
    'root',
    '--entrypoint',
    'sh',
    '--volume',
    `${signIn}:/sign-in`,
    image,
    '-c',
    `printf %s ${dockerTokenValue} > /sign-in/claude-oauth-token && chmod 644 /sign-in/claude-oauth-token`,
  );

  mkdirSync(join(home.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    paths.configFile,
    JSON.stringify({
      targets: { box: { provider: 'docker', image, namePrefix: prefix } },
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = Bun.spawn([binary, 'daemon'], {
    env: { ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const stop = () => {
    daemon.kill('SIGTERM');
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
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
        socket: paths.daemonSocketPath,
        db: paths.dbFile,
        prefix,
      })}\n`,
    );

    process.exitCode = await daemon.exited;
  } finally {
    daemon.kill('SIGTERM');

    await removeDockerObjects();
  }
}

// The flags of `scripts/build-binaries.sh`, for the host's own platform.
async function runCompile(entry: string, outfile: string): Promise<void> {
  const build = Bun.spawn(
    [
      process.execPath,
      'build',
      '--compile',
      '--bytecode',
      '--format=esm',
      '--no-compile-autoload-dotenv',
      entry,
      '--outfile',
      outfile,
    ],
    { stdout: 'ignore', stderr: 'inherit' },
  );

  const exitCode = await build.exited;

  if (exitCode !== 0) {
    throw new Error(`bun build --compile exited ${String(exitCode)}`);
  }

  // a container's user runs the binary, and the run's umask makes it owner-only
  chmodSync(outfile, 0o755);
}

if (import.meta.main) {
  await runDockerDaemon(process.env);
}
