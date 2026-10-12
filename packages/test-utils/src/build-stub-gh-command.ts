import type { HostCommandResult, HostServices } from '@atc/plugin-api/host-services';

interface StubGHReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface StubGHCommandOptions {
  // What each gh command prints and exits with, keyed by its first
  // argument, such as `repo` or `config`; `hang` runs until the run's
  // signal aborts. A command without a reply prints nothing and exits 0.
  readonly replies: Readonly<Record<string, StubGHReply | 'hang'>>;
}

interface StubGHCommand {
  // A host command runner that answers each gh run with its reply.
  readonly runCommand: HostServices['runCommand'];

  // The argv of every run, in order, the gh executable first.
  readonly calls: readonly (readonly string[])[];
}

/**
 * A stand-in for gh behind the host's command runner, so a source's test
 * drives gh with no process. Each run answers as the host's runner does:
 * output trimmed, and an aborted run, or one whose signal aborted before
 * the call, as exit code -1 with no output.
 */
export function buildStubGHCommand(options: StubGHCommandOptions): StubGHCommand {
  const calls: (readonly string[])[] = [];

  return {
    calls,
    runCommand: (argv, runOptions) => {
      calls.push([...argv]);

      const reply = options.replies[argv[1] ?? ''] ?? {};

      if (reply === 'hang') {
        return waitForAbort(runOptions?.signal);
      }

      return Promise.resolve({
        code: reply.exitCode ?? 0,
        stdout: (reply.stdout ?? '').trim(),
        stderr: (reply.stderr ?? '').trim(),
        aborted: false,
      });
    },
  };
}

// A run that hangs until its signal aborts; without a signal, forever.
function waitForAbort(signal: AbortSignal | undefined): Promise<HostCommandResult> {
  const ended = Promise.withResolvers<HostCommandResult>();

  const onAbort = () => {
    ended.resolve({ code: -1, stdout: '', stderr: '', aborted: true });
  };

  if (signal?.aborted === true) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }

  return ended.promise;
}
