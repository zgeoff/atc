import { randomUUID } from 'node:crypto';

interface SessionScopesConfig {
  // The user service whose main process is the daemon, such as
  // `atc-daemon.service`.
  readonly unit: string;

  // The daemon run's own token, such as the start of its `INVOCATION_ID`,
  // which every scope it starts holds in its name.
  readonly run: string;

  // Absolute paths of the manager's `systemctl` and of a `systemd-run` that
  // takes `--expand-environment`.
  readonly systemctl: string;
  readonly systemdRun: string;
}

export class SessionScopes {
  private readonly config: SessionScopesConfig;

  // Every scope a harness runs in starts with this, the service's name
  // without its suffix: two daemons in services of their own never share
  // one.
  private readonly prefix: string;

  // Every scope this daemon run starts, from any of its targets, starts
  // with this.
  private readonly runPrefix: string;

  // The scopes this provider started harnesses in, ended or not: a process
  // a harness left behind outlives the harness.
  private readonly started = new Set<string>();

  constructor(config: SessionScopesConfig) {
    this.config = config;
    this.prefix = `${config.unit.replace(/\.service$/u, '')}-session-`;
    this.runPrefix = `${this.prefix}${config.run}-`;
  }

  // systemd-run replaces itself with the program, so the pid stays the
  // program's own. A name of its own keeps a scope a stop still holds from
  // blocking the session's next start.
  buildCommand(
    session: string,
    argv: readonly string[],
  ): Readonly<{ file: string; args: string[] }> {
    const name = `${this.runPrefix}${session.replaceAll(/[^\w.-]/gu, '_')}-${randomUUID().slice(0, 8)}.scope`;

    this.started.add(name);

    return {
      file: this.config.systemdRun,
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--expand-environment=no',
        `--unit=${name}`,
        `--description=atc session ${session}`,
        `--property=BindsTo=${this.config.unit}`,
        '--',
        ...argv,
      ],
    };
  }

  // Never rejects: a manager that does not answer leaves each leftover scope to
  // its own stop.
  async stopLeftovers(): Promise<void> {
    let stdout: string;
    let exitCode: number;

    try {
      const show = Bun.spawn(
        [
          this.config.systemctl,
          '--user',
          'show',
          '--property=BoundBy',
          '--value',
          this.config.unit,
        ],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
      );

      [stdout, exitCode] = await Promise.all([new Response(show.stdout).text(), show.exited]);
    } catch {
      return;
    }

    if (exitCode !== 0) {
      return;
    }

    const names = stdout
      .split(/\s+/u)
      .filter(
        (name) =>
          name.startsWith(this.prefix) &&
          !name.startsWith(this.runPrefix) &&
          name.endsWith('.scope'),
      );

    await this.runStop(names);
  }

  // One systemctl starts before this returns, so a daemon that exits at once
  // still queues every stop. Never rejects.
  stop(): Promise<void> {
    return this.runStop([...this.started]);
  }

  private async runStop(names: readonly string[]): Promise<void> {
    if (names.length === 0) {
      return;
    }

    try {
      const stop = Bun.spawn([this.config.systemctl, '--user', 'stop', '--no-block', ...names], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });

      await stop.exited;
    } catch {
      // A manager that cannot queue the stops leaves each scope to its own.
    }
  }
}
