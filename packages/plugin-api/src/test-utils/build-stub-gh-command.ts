import type { HostCommandResult, HostServices } from '../index';

interface StubGHReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface StubGHCommandOptions {
  readonly replies: Readonly<Record<string, StubGHReply | 'hang' | readonly StubGHReply[]>>;
}

interface StubGHCommand {
  readonly runCommand: HostServices['runCommand'];

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

function waitForAbort(signal: Readonly<AbortSignal> | undefined): Promise<HostCommandResult> {
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
