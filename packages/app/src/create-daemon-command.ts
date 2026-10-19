import { define, lazy } from 'gunshi';

// The flags `atc daemon restart` and its worker share, parsed only as far as
// the parser checks them.
interface RestartFlags {
  readonly listen: string | null;
  readonly tokenFile: string | null;
  readonly timeout: string | null;
}

// The runs the `atc daemon` command and its subcommands hand their flags to.
export interface DaemonCommandIO {
  readonly runDaemon: (listen: string | null, tokenFile: string | null) => Promise<void>;
  readonly runDaemonID: () => Promise<void>;
  readonly runDaemonRestart: (flags: RestartFlags & { readonly dryRun: boolean }) => Promise<void>;
  readonly runDaemonRestartWorker: (
    flags: RestartFlags & { readonly runID: string; readonly session: string | null },
  ) => Promise<void>;
}

// The `atc daemon` flags as the parser gives them.
interface DaemonValues {
  readonly listen?: string | undefined;
  readonly 'token-file'?: string | undefined;
}

export function createDaemonCommand(io: DaemonCommandIO) {
  const runDaemonServe = async (values: DaemonValues): Promise<void> => {
    await io.runDaemon(values.listen ?? null, values['token-file'] ?? null);
  };

  return define({
    name: 'daemon',
    description: 'Run the atc daemon in the foreground',
    args: DAEMON_ARGS,
    subCommands: {
      serve: lazy(
        () => async (ctx) => {
          await runDaemonServe(ctx.values);
        },
        {
          name: 'serve',
          description: 'Run the atc daemon in the foreground',
          internal: true,
          args: DAEMON_ARGS,
        },
      ),
      id: lazy(
        () => async () => {
          await io.runDaemonID();
        },
        { name: 'id', description: "Print the running daemon's daemonID" },
      ),
      restart: lazy(
        () => async (ctx) => {
          await io.runDaemonRestart({
            listen: ctx.values.listen ?? null,
            tokenFile: ctx.values['token-file'] ?? null,
            timeout: ctx.values.timeout ?? null,
            dryRun: ctx.values['dry-run'],
          });
        },
        {
          name: 'restart',
          description: 'Restart the running daemon and restore its fleet',
          args: {
            ...DAEMON_ARGS,
            timeout: {
              type: 'string',
              description: 'Seconds to wait for the restored fleet to come alive',
            },
            'dry-run': {
              type: 'boolean',
              default: false,
              description: 'Print what the restart would do and stop',
            },
          },
        },
      ),
      'restart-worker': lazy(
        () => async (ctx) => {
          await io.runDaemonRestartWorker({
            listen: ctx.values.listen ?? null,
            tokenFile: ctx.values['token-file'] ?? null,
            timeout: ctx.values.timeout ?? null,
            runID: ctx.values.runID,
            session: ctx.values.session ?? null,
          });
        },
        {
          name: 'restart-worker',
          description: 'Run one daemon restart for atc daemon restart',
          internal: true,
          args: {
            ...DAEMON_ARGS,
            runID: { type: 'positional', description: 'The run id' },
            session: { type: 'string', description: 'The session that asked for the restart' },
            timeout: { type: 'string', description: 'Seconds to wait for the restored fleet' },
          },
        },
      ),
    },
    run: async (ctx) => {
      await runDaemonServe(ctx.values);
    },
  });
}

// The flags `atc daemon` takes, on its own and on each command that starts
// a daemon.
const DAEMON_ARGS = {
  listen: {
    type: 'string',
    description: 'Serve the client protocol on <host>:<port> too, a loopback or tailnet address',
  },
  'token-file': {
    type: 'string',
    description: 'File holding the one or two bearer tokens a --listen handshake must present',
  },
} as const;
