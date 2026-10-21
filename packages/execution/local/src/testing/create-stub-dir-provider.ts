import { mkdir } from 'node:fs/promises';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionCapability,
  ExecutionProvider,
  HarnessHandle,
  HarnessSpec,
} from '@atc/plugin-api';
import { createLocalPTYProvider } from '../create-local-pty-provider';

// One provider operation, in the order the daemon called it.
type StubDirCall =
  | { readonly op: 'transfer'; readonly directory: string; readonly bytes: number }
  | { readonly op: 'run'; readonly argv: readonly string[]; readonly cwd: string };

interface StubDirOptions {
  // Capabilities the provider declares as missing.
  readonly lacking?: readonly ExecutionCapability[];

  // Runs once an archive is unpacked, before the transfer resolves, so a
  // test can change what landed on the host or hold the transfer open.
  readonly afterTransfer?: (directory: string) => Promise<void>;
}

interface StubDirProvider extends ExecutionProvider {
  readonly calls: StubDirCall[];

  // Every harness the provider started, as the daemon specified it.
  readonly harnesses: HarnessSpec[];
}

export function createStubDirProvider(options: StubDirOptions = {}): StubDirProvider {
  const calls: StubDirCall[] = [];
  const harnesses: HarnessSpec[] = [];
  const terminals = createLocalPTYProvider();

  const lacking = new Set(options.lacking);

  const capabilities: ExecutionCapabilities = {
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

  const afterTransfer = options.afterTransfer;

  return {
    kind: 'fixture-dir',

    remote: false,

    capabilities,

    calls,

    harnesses,

    prepareHost: (): Promise<void> => Promise.resolve(),

    spawnHarness: (spec: HarnessSpec): HarnessHandle => {
      harnesses.push(spec);

      return terminals.spawnHarness(spec);
    },

    transferArchive: async (archive: Uint8Array, directory: string): Promise<void> => {
      calls.push({ op: 'transfer', directory, bytes: archive.byteLength });

      await mkdir(directory, { recursive: true });

      const subprocess = Bun.spawn(['tar', '-x', '-f', '-', '-C', directory], {
        stdin: archive,
        stdout: 'ignore',
        stderr: 'pipe',
      });

      const [stderr, exitCode] = await Promise.all([
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(`tar exited ${exitCode} unpacking into ${directory}: ${stderr}`);
      }

      await afterTransfer?.(directory);
    },

    runCommand: async (spec: CommandSpec): Promise<CommandResult> => {
      calls.push({ op: 'run', argv: spec.argv, cwd: spec.cwd });

      // The command inherits the daemon's environment as it stands now, which
      // a spawn without an env option would take only from process start.
      const subprocess = Bun.spawn([...spec.argv], {
        cwd: spec.cwd,
        env: process.env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);

      return { exitCode, stdout, stderr };
    },

    // The host is the test's own directory tree, which neither sleeps nor
    // goes away.
    suspendHost: (host: string): Promise<void> =>
      Promise.reject(new Error(`the fixture-dir provider cannot suspend host ${host}`)),

    destroyHost: (host: string): Promise<void> =>
      Promise.reject(new Error(`the fixture-dir provider cannot destroy host ${host}`)),

    dispose: (): void => {},
  };
}
