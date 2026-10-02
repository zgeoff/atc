import { mkdir } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionProvider,
  HarnessHandle,
  HarnessSpec,
} from './execution-provider';

/**
 * The `local-pty` provider: harnesses run as child processes of the daemon
 * on a `bun-pty` pseudo-terminal, and files and commands touch the daemon's
 * own host. The host is the daemon's machine, so there is nothing to
 * suspend or destroy.
 */
export class LocalPTYProvider implements ExecutionProvider {
  readonly kind = 'local-pty';

  readonly capabilities: ExecutionCapabilities = {
    spawn: true,
    attach: true,
    input: true,
    resize: true,
    kill: true,
    transfer: true,
    run: true,
    suspend: false,
    destroy: false,
  };

  readonly spawnHarness = (spec: HarnessSpec): HarnessHandle =>
    spawn(spec.bin, [...spec.args], {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: { ...spec.env },
    });

  // oxlint-disable-next-line prefer-readonly-parameter-types -- archive bytes have no readonly form
  readonly transferArchive = async (archive: Uint8Array, dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true });

    const result = await this.runCommandWithInput(
      ['tar', '-x', '-f', '-', '-C', dir],
      dir,
      archive,
    );

    if (result.exitCode !== 0) {
      throw new Error(`tar exited ${result.exitCode} unpacking into ${dir}: ${result.stderr}`);
    }
  };

  readonly runCommand = (spec: CommandSpec): Promise<CommandResult> =>
    this.runCommandWithInput(spec.argv, spec.cwd, null);

  private async runCommandWithInput(
    argv: readonly string[],
    cwd: string,

    // oxlint-disable-next-line prefer-readonly-parameter-types -- input bytes have no readonly form
    input: Uint8Array | null,
  ): Promise<CommandResult> {
    const proc = Bun.spawn([...argv], {
      cwd,
      stdin: input ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  }
}
