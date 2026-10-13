import { randomUUID } from 'node:crypto';

/**
 * The daemon's user service and the programs that reach its service manager.
 */
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

/**
 * Starts each harness of a daemon that a user service runs in a transient
 * scope of its own, so the service's cgroup holds only the daemon. A
 * process a harness leaves behind that cannot exit, such as one stuck in an
 * uninterruptible wait, then holds its scope in a stop and never the
 * service, so a stop or restart of the service never waits on it.
 *
 * Each scope binds to the service, so a stop of the service stops the scope
 * as well, without waiting for it. A restart of the service stops no bound
 * scope, so the daemon stops its scopes itself as it stops, and stops the
 * ones a daemon that ended without that stop left behind as it starts. A
 * stop only queues each scope's stop with the service manager and never
 * waits for a scope to end.
 */
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
    this.prefix = `${config.unit.replace(/\.service$/, '')}-session-`;
    this.runPrefix = `${this.prefix}${config.run}-`;
  }

  /**
   * The program and its arguments that start `argv` in a new scope for the
   * session. `systemd-run` moves itself into the scope and replaces itself
   * with the program, so the pid stays the program's own. It would also
   * expand each `$` reference in the program's arguments, so expansion is
   * switched off. Each scope takes a name of its own, so a scope that a stop
   * still holds never blocks the session's next start.
   */
  buildCommand(
    session: string,
    argv: readonly string[],
  ): Readonly<{ file: string; args: string[] }> {
    const name = `${this.runPrefix}${session.replaceAll(/[^\w.-]/g, '_')}-${randomUUID().slice(0, 8)}.scope`;

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

  /**
   * Stops the scopes bound to the service that an earlier daemon run in it
   * started and left behind, and none this run started from any target. A manager that
   * does not answer leaves each leftover scope to its own stop, and the
   * returned promise never rejects.
   */
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
      .split(/\s+/)
      .filter(
        (name) =>
          name.startsWith(this.prefix) &&
          !name.startsWith(this.runPrefix) &&
          name.endsWith('.scope'),
      );

    await this.runStop(names);
  }

  /**
   * Stops every scope this provider started. The stop starts one `systemctl`
   * before this returns, so a daemon that exits at once still queues every
   * stop. A scope that already ended is skipped, and the returned promise
   * never rejects.
   */
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
