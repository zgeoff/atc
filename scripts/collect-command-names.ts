import type { ShellWord } from './parse-shell-words.ts';
import { parseShellWords } from './parse-shell-words.ts';

// Each command contributes the word the shell runs, after any NAME=value assignments, plus the
// script that bash, sh or bun runs. A command outside the forms read here returns undefined, so the
// caller skips the step rather than guess what it runs.
export function collectCommandNames(words: readonly ShellWord[]): string[] | undefined {
  const names = splitCommands(words).map((command) => collectRunTargets(command));

  return names.every((targets) => targets !== undefined) ? names.flat() : undefined;
}

function splitCommands(words: readonly ShellWord[]): ShellWord[][] {
  const commands: ShellWord[][] = [[]];

  for (const word of words) {
    if (word.isOperator) {
      commands.push([]);
    } else {
      commands.at(-1)?.push(word);
    }
  }

  return commands;
}

// A command substitution runs a command that the parser does not split out, a heredoc body holds
// lines that are data, and a name held in a variable is known only when the step runs.
const unreadablePattern = /\$\((?!\()|`|(?<!<)<<(?!<)/u;

function collectRunTargets(command: readonly ShellWord[]): string[] | undefined {
  const start = command.findIndex((word) => !word.isAssignment);
  const words = start === -1 ? [] : command.slice(start).map((word) => word.text);
  const [name, ...rest] = words;

  if (name === undefined) {
    return [];
  }

  if (words.some((word) => unreadablePattern.test(word)) || name.includes('$')) {
    return undefined;
  }

  if (name === 'bash' || name === 'sh') {
    return collectShellTargets(name, rest);
  }

  return name === 'bun' ? collectBunTargets(rest) : [name];
}

const shellLongOptions = new Set(['--login', '--noediting', '--noprofile', '--norc', '--posix']);

// With -s a shell reads its commands from standard input, so its first operand is an argument, and
// with -c that operand is a command string. -o and +o take an option name.
function collectShellTargets(name: string, args: readonly string[]): string[] | undefined {
  let flags = '';
  let index = 0;

  while (index < args.length) {
    const argument = args[index] ?? '';

    if (argument === '--') {
      index += 1;
      break;
    }

    if (argument === '-o' || argument === '+o') {
      index += 2;
    } else if (/^[-+][A-Za-z]+$/u.test(argument)) {
      flags += argument.slice(1);
      index += 1;
    } else if (argument.startsWith('-')) {
      if (!shellLongOptions.has(argument)) {
        return undefined;
      }

      index += 1;
    } else {
      break;
    }
  }

  return collectShellOperandTargets(name, flags, args[index]);
}

function collectShellOperandTargets(
  name: string,
  flags: string,
  operand: string | undefined,
): string[] | undefined {
  if (flags.includes('s')) {
    return [name];
  }

  if (!flags.includes('c')) {
    return operand === undefined ? [name] : [name, operand];
  }

  const words = operand === undefined ? undefined : parseShellWords(operand);
  const names = words === undefined ? undefined : collectCommandNames(words);

  return names === undefined ? undefined : [name, ...names];
}

// The subcommands `bun --help` lists, with their short aliases. Bun runs any other first operand as
// a file or a package script.
const bunCommands = new Set([
  'a',
  'add',
  'audit',
  'build',
  'c',
  'check',
  'create',
  'dedupe',
  'exec',
  'i',
  'info',
  'init',
  'install',
  'link',
  'lint',
  'outdated',
  'patch',
  'pm',
  'prune',
  'publish',
  'remove',
  'repl',
  'rm',
  'test',
  'unlink',
  'update',
  'upgrade',
  'why',
  'x',
]);

function collectBunTargets(args: readonly string[]): string[] | undefined {
  const firstIndex = findBunOperand(args, 0);
  const first = firstIndex === undefined ? undefined : args[firstIndex];

  if (firstIndex === undefined) {
    return undefined;
  }

  if (first !== 'run') {
    return first === undefined || bunCommands.has(first) ? ['bun'] : ['bun', first];
  }

  const scriptIndex = findBunOperand(args, firstIndex + 1);
  const script = scriptIndex === undefined ? undefined : args[scriptIndex];

  if (scriptIndex === undefined) {
    return undefined;
  }

  return script === undefined ? ['bun'] : ['bun', script];
}

// The options `bun run --help` lists that take a value, as `--cwd dir` or `--cwd=dir`.
const bunValueOptions = new Set([
  '-F',
  '--filter',
  '-r',
  '--preload',
  '--require',
  '--import',
  '-d',
  '--define',
  '-l',
  '--loader',
  '-c',
  '--config',
  '--conditions',
  '--console-depth',
  '--cpu-prof-dir',
  '--cpu-prof-interval',
  '--cpu-prof-name',
  '--cron-period',
  '--cron-title',
  '--cwd',
  '--disable-warning',
  '--dns-result-order',
  '--drop',
  '--elide-lines',
  '--env-file',
  '--extension-order',
  '--feature',
  '--fetch-preconnect',
  '--heap-prof-dir',
  '--heap-prof-interval',
  '--heap-prof-name',
  '--install',
  '--jsx-factory',
  '--jsx-fragment',
  '--jsx-import-source',
  '--jsx-runtime',
  '--main-fields',
  '--max-http-header-size',
  '--port',
  '--redirect-warnings',
  '--shell',
  '--title',
  '--tsconfig-override',
  '--unhandled-rejections',
  '--user-agent',
  '--watch-kill-signal',
]);

// The options `bun run --help` lists that take no value. The inspect options take one only after
// an `=`.
const bunFlagOptions = new Set([
  '-b',
  '--bun',
  '-h',
  '--help',
  '--check',
  '--cpu-prof',
  '--cpu-prof-md',
  '--experimental-http2-fetch',
  '--experimental-http3-fetch',
  '--experimental-stream-iter',
  '--expose-gc',
  '--heap-prof',
  '--heap-prof-md',
  '--hot',
  '--if-present',
  '--ignore-dce-annotations',
  '--insecure-http-parser',
  '--inspect',
  '--inspect-brk',
  '--inspect-wait',
  '--interactive',
  '--jsx-side-effects',
  '--no-addons',
  '--no-clear-screen',
  '--no-deprecation',
  '--no-env-file',
  '--no-exit-on-error',
  '--no-ffi-cc',
  '--no-install',
  '--no-macros',
  '--no-orphans',
  '--no-warnings',
  '--parallel',
  '--pending-deprecation',
  '--prefer-latest',
  '--prefer-offline',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--redis-preconnect',
  '--sequential',
  '--silent',
  '--smol',
  '--sql-preconnect',
  '--throw-deprecation',
  '--tls-max-v1.2',
  '--tls-max-v1.3',
  '--tls-min-v1.0',
  '--tls-min-v1.1',
  '--tls-min-v1.2',
  '--tls-min-v1.3',
  '--trace-deprecation',
  '--trace-warnings',
  '--use-bundled-ca',
  '--use-openssl-ca',
  '--use-system-ca',
  '--watch',
  '--workspaces',
  '--zero-fill-buffers',
]);

// The index of the first operand at or after start, past each option and the value it takes; the
// length of args when no operand follows, and undefined at an option outside the two tables.
function findBunOperand(args: readonly string[], start: number): number | undefined {
  let index = start;

  while (index < args.length) {
    const argument = args[index] ?? '';
    const option = argument.split('=')[0] ?? '';

    if (!argument.startsWith('-')) {
      return index;
    }

    if (bunValueOptions.has(option)) {
      index += argument.includes('=') ? 1 : 2;
    } else if (bunFlagOptions.has(option)) {
      index += 1;
    } else {
      return undefined;
    }
  }

  return index;
}
