interface HarnessArgvConfig {
  // The names `env` unsets before it starts the program.
  readonly unset: readonly string[];

  // The map the harness starts with.
  readonly env: Readonly<Record<string, string>>;

  readonly platform: NodeJS.Platform;

  // The resolved program path and its arguments.
  readonly bin: string;
  readonly args: readonly string[];
}

/**
 * The arguments `env` takes to start a harness: every name to unset, then
 * the program and its arguments.
 *
 * macOS clears every `DYLD_` variable on the way into a protected system
 * program such as `env` or `/bin/sh`, so on macOS the map's own ones are set
 * again after the unsets, the one place the argv holds a value. `env` reads
 * a word holding `=` as an assignment even after `--`, so a program path
 * holding one starts through `/bin/sh`, which exports those variables again
 * before it runs the program by its first argument. The shell reads each
 * value from a positional argument and never from its script, so no value
 * needs quoting.
 */
export function buildHarnessArgv(config: HarnessArgvConfig): string[] {
  const unset = [...config.unset.flatMap((name) => ['-u', name]), '--'];
  const dyld = config.platform === 'darwin' ? collectDYLDEntries(config.env) : [];

  if (!config.bin.includes('=')) {
    return [...unset, ...dyld.map((entry) => toAssignment(entry)), config.bin, ...config.args];
  }

  const exported = dyld.filter(([name]) => SHELL_NAME.test(name));
  const assigned = dyld.filter(([name]) => !SHELL_NAME.test(name));

  return [
    ...unset,
    ...assigned.map((entry) => toAssignment(entry)),
    '/bin/sh',
    '-c',
    buildShellScript(exported.map(([name]) => name)),
    config.bin,
    ...exported.map(([, value]) => value),
    ...config.args,
  ];
}

function collectDYLDEntries(env: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(env).filter(([name]) => name.startsWith('DYLD_'));
}

function toAssignment([name, value]: readonly [string, string]): string {
  return `${name}=${value}`;
}

// A name the shell's `export` refuses, which would end the shell before it
// runs the program, stays an assignment word for `env` instead.
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The shell's `$0` is the program path, and the values sit in `$1` onward,
// in the order of the names, ahead of the program's own arguments. Each
// index is braced, since the shell reads `$10` as `$1` then a `0`.
function buildShellScript(names: readonly string[]): string {
  if (names.length === 0) {
    return 'exec "$0" "$@"';
  }

  const exports = names.map((name, index) => `${name}="\${${index + 1}}"`).join(' ');

  return `export ${exports}; shift ${names.length}; exec "$0" "$@"`;
}
