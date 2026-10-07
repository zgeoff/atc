import { mkdir } from 'node:fs/promises';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionCapability,
  ExecutionProvider,
  HarnessHandle,
  HarnessSpec,
} from '../daemon/execution-provider';
import { LocalPTYProvider } from '../daemon/local-pty-provider';

// One provider operation, in the order the daemon called it.
type FixtureCall =
  | { readonly op: 'transfer'; readonly dir: string; readonly bytes: number }
  | { readonly op: 'run'; readonly argv: readonly string[]; readonly cwd: string };

interface FixtureDirOptions {
  // Capabilities the provider declares as missing.
  readonly lacking?: readonly ExecutionCapability[];

  // Runs once an archive is unpacked, before the transfer resolves, so a
  // test can change what landed on the host or hold the transfer open.
  readonly afterTransfer?: (dir: string) => Promise<void>;
}

/**
 * An execution provider for tests whose host is a directory tree the test
 * owns: a transfer unpacks the archive with tar into the directory it is
 * given, and a command runs as a child process in its working directory.
 * Paths pass through unchanged, so a test points them into its own temp
 * tree. Every transfer and command is recorded in `calls`. Harnesses start
 * on a local pseudo-terminal, and each one's spec is recorded in
 * `harnesses`.
 */
export class FixtureDirProvider implements ExecutionProvider {
  readonly kind = 'fixture-dir';

  readonly remote = false;

  readonly capabilities: ExecutionCapabilities;

  readonly calls: FixtureCall[] = [];

  // Every harness the provider started, as the daemon specified it.
  readonly harnesses: HarnessSpec[] = [];

  private readonly afterTransfer: ((dir: string) => Promise<void>) | undefined;

  private readonly terminals = new LocalPTYProvider();

  constructor(options: FixtureDirOptions = {}) {
    const lacking = new Set(options.lacking);

    this.capabilities = {
      spawn: !lacking.has('spawn'),
      attach: !lacking.has('attach'),
      input: !lacking.has('input'),
      resize: !lacking.has('resize'),
      kill: !lacking.has('kill'),
      transfer: !lacking.has('transfer'),
      run: !lacking.has('run'),
      headless: false,
      suspend: false,
      destroy: false,
    };

    this.afterTransfer = options.afterTransfer;
  }

  readonly prepareHost = (): Promise<void> => Promise.resolve();

  readonly spawnHarness = (spec: HarnessSpec): HarnessHandle => {
    this.harnesses.push(spec);

    return this.terminals.spawnHarness(spec);
  };

  // oxlint-disable-next-line prefer-readonly-parameter-types -- archive bytes have no readonly form
  readonly transferArchive = async (archive: Uint8Array, dir: string): Promise<void> => {
    this.calls.push({ op: 'transfer', dir, bytes: archive.byteLength });

    await mkdir(dir, { recursive: true });

    const proc = Bun.spawn(['tar', '-x', '-f', '-', '-C', dir], {
      stdin: archive,
      stdout: 'ignore',
      stderr: 'pipe',
    });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    if (exitCode !== 0) {
      throw new Error(`tar exited ${exitCode} unpacking into ${dir}: ${stderr}`);
    }

    await this.afterTransfer?.(dir);
  };

  readonly runCommand = async (spec: CommandSpec): Promise<CommandResult> => {
    this.calls.push({ op: 'run', argv: spec.argv, cwd: spec.cwd });

    // The command inherits the daemon's environment as it stands now, which
    // a spawn without an env option would take only from process start.
    const proc = Bun.spawn([...spec.argv], {
      cwd: spec.cwd,
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  };

  // The host is the test's own directory tree, which neither sleeps nor
  // goes away.
  readonly suspendHost = (host: string): Promise<void> =>
    Promise.reject(new Error(`the fixture-dir provider cannot suspend host ${host}`));

  readonly destroyHost = (host: string): Promise<void> =>
    Promise.reject(new Error(`the fixture-dir provider cannot destroy host ${host}`));

  readonly dispose = (): void => {};
}
