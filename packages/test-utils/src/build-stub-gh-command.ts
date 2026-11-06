import type { HostCommandResult, HostServices } from '@atc/plugin-api';

interface StubGHReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface StubGHCommandOptions {
  // Each gh command's reply, keyed by its first argument, such as `repo`:
  // `hang` runs until the run's signal aborts, a list answers one run per
  // reply in order, and a command without a reply prints nothing.
  readonly replies: Readonly<Record<string, StubGHReply | 'hang' | readonly StubGHReply[]>>;
}

interface StubGHCommand {
  // A host command runner that answers each gh run with its reply.
  readonly runCommand: HostServices['runCommand'];

  // The argv of every run, in order, the gh executable first.
  readonly calls: readonly (readonly string[])[];
}

export function buildStubGHCommand(options: StubGHCommandOptions): StubGHCommand {
  const calls: (readonly string[])[] = [];

  const runCounts = new Map<string, number>();

  return {
    calls,
    runCommand: (argv, runOptions) => {
      calls.push([...argv]);

      const command = argv[1] ?? '';
      const runCount = runCounts.get(command) ?? 0;

      runCounts.set(command, runCount + 1);

      const reply = pickReply(options.replies[command], runCount);

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

// The reply for a command's run, counting its runs from 0.
function pickReply(
  reply: StubGHReply | 'hang' | readonly StubGHReply[] | undefined,
  runCount: number,
): StubGHReply | 'hang' {
  if (reply === undefined || reply === 'hang') {
    return reply ?? {};
  }

  return isReplyList(reply) ? (reply[runCount] ?? {}) : reply;
}

function isReplyList(reply: StubGHReply | readonly StubGHReply[]): reply is readonly StubGHReply[] {
  return Array.isArray(reply);
}

// A run that hangs until its signal aborts; without a signal, forever.
function waitForAbort(signal: Readonly<AbortSignal> | undefined): Promise<HostCommandResult> {
  const ended = Promise.withResolvers<HostCommandResult>();

  // An aborted run answers as the host's runner answers one: exit code -1 and
  // no output.
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
