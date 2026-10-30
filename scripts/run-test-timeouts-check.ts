import { basename, dirname, posix } from 'node:path';
import { parseLaneLimits } from './parse-lane-limits.ts';
import type { ShellWord } from './parse-shell-words.ts';
import { parseShellWords } from './parse-shell-words.ts';
import type { RunProgram } from './run-program.ts';
import { runProgram } from './run-program.ts';

export interface TestTimeoutsCheckOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runProgram: RunProgram;
}

export interface TestTimeoutFinding {
  // Relative to the repo root.
  readonly path: string;

  readonly message: string;
}

// The check reads the files as HEAD holds them, so a push checks what it sends.
export function runTestTimeoutsCheck(
  options: Readonly<TestTimeoutsCheckOptions>,
): TestTimeoutFinding[] {
  const paths = runGit(options, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0');

  const configText = paths.includes(oxlintConfigPath)
    ? runGit(options, ['show', `HEAD:${oxlintConfigPath}`])
    : null;

  const limits = parseLaneLimits(configText);

  const appRoots = new Set(
    paths.filter((path) => basename(path) === 'package.json').map((path) => dirname(path)),
  );

  return paths
    .filter((path) => checkedFiles.has(basename(path)) || configPattern.test(basename(path)))
    .flatMap((path) => {
      const text = runGit(options, ['show', `HEAD:${path}`]);

      if (configPattern.test(basename(path))) {
        return collectConfigFindings(path, text);
      }

      return basename(path) === 'package.json'
        ? collectScriptFindings(path, text, limits)
        : collectBunfigFindings(
            path,
            text,
            pickLaneLimit(limits, findDirectoryLane(path, appRoots)),
          );
    });
}

const configPattern = /^\.?oxlintrc(?:\.[\w-]+)?\.jsonc?$/u;
const oxlintConfigPath = '.oxlintrc.json';

const checkedFiles = new Set(['package.json', 'bunfig.toml']);

function runGit(options: Readonly<TestTimeoutsCheckOptions>, args: readonly string[]): string {
  const result = options.runProgram(['git', ...args], { cwd: options.cwd, env: options.env });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

// A setting that turns a timeout rule off or down to a warning escapes the limits as a disable
// comment does, so it needs the same ticket, in a comment on its line or the lines above it.
function collectConfigFindings(path: string, text: string): TestTimeoutFinding[] {
  const tokens = parseJSONCTokens(path, text);
  const values = tokens.filter((token) => token.kind !== 'comment');
  const comments = tokens.filter((token) => token.kind === 'comment');

  const valueLines = new Set(values.map((token) => token.line));

  const overrides = collectOverrideLines(values);

  return values.flatMap((token, index) => {
    const rule =
      token.kind === 'string' ? guardedRules.find((name) => name === token.text) : undefined;

    if (rule === undefined || values[index + 1]?.text !== ':') {
      return [];
    }

    const first = values[index + 2];
    const severity = first?.text === '[' ? values[index + 3] : first;

    if (severity === undefined || !weakSeverities.has(severity.text)) {
      return [];
    }

    const override = overrides.get(index);

    const notes = comments.filter(
      (comment) =>
        (comment.line >= token.line && comment.line <= severity.line) ||
        isCommentAbove(comment, token.line, valueLines) ||
        (override !== undefined &&
          (comment.line === override || isCommentAbove(comment, override, valueLines))),
    );

    if (
      notes.some((comment) => ticketPattern.test(comment.text) || floorPattern.test(comment.text))
    ) {
      return [];
    }

    return [
      {
        path,
        message: `line ${token.line} turns ${rule} off or down to a warning; give the setting a comment that names the ticket that tracks the fix, or "floor:" and the evidence that the time cannot move, as the "Slow tests" section of the testing skill describes`,
      },
    ];
  });
}

const weakSeverities = new Set(['off', 'warn', 'allow', '0', '1']);

interface JSONCToken {
  readonly kind: 'string' | 'comment' | 'other';

  // A string's or a comment's content, or the token's own text.
  readonly text: string;

  // The 1-based lines the token starts and ends on.
  readonly line: number;
  readonly endLine: number;
}

function parseJSONCTokens(path: string, text: string): JSONCToken[] {
  const tokens: JSONCToken[] = [];
  let line = 1;
  let index = 0;

  const advance = (end: number): number => {
    const start = line;

    for (let at = index; at < end; at += 1) {
      if (text.charAt(at) === '\n') {
        line += 1;
      }
    }

    index = end;

    return start;
  };

  while (index < text.length) {
    const character = text.charAt(index);
    const next = text.charAt(index + 1);

    if (/\s/u.test(character)) {
      advance(index + 1);
    } else if (character === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? text.indexOf('\n', index) : text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close;
      const body = text.slice(index + 2, end);
      const after = next === '/' || close === -1 ? end : end + 2;
      const start = advance(after);

      tokens.push({ kind: 'comment', text: body, line: start, endLine: line });
    } else if (character === '"') {
      const end = getStringEnd(path, text, index);
      const body = parseText(path, text.slice(index, end), (input) => JSON.parse(input));
      const start = advance(end);

      tokens.push({ kind: 'string', text: String(body), line: start, endLine: line });
    } else {
      const word = /^[\w.+-]+/u.exec(text.slice(index))?.[0] ?? character;
      const start = advance(index + word.length);

      tokens.push({ kind: 'other', text: word, line: start, endLine: line });
    }
  }

  return tokens;
}

function getStringEnd(path: string, text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text.charAt(index);

    if (character === '\\') {
      index += 1;
    } else if (character === '"') {
      return index + 1;
    }
  }

  throw new Error(`cannot parse ${path}: a string never closes`);
}

function parseText(path: string, text: string, parse: (input: string) => unknown): unknown {
  try {
    return parse(text);
  } catch (error) {
    throw new Error(
      `cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function collectOverrideLines(values: readonly JSONCToken[]): ReadonlyMap<number, number> {
  const lines = new Map<number, number>();

  const open: number[] = [];

  for (const [index, token] of values.entries()) {
    if (token.text === '{') {
      open.push(index);
    } else if (token.text === '}') {
      open.pop();
    }

    const override = open.length >= 3 ? values[open[1] ?? 0] : undefined;

    if (override !== undefined) {
      lines.set(index, override.line);
    }
  }

  return lines;
}

// a comment above the setting counts while no other value sits between them
function isCommentAbove(
  comment: JSONCToken,
  line: number,
  valueLines: ReadonlySet<number>,
): boolean {
  if (comment.endLine >= line) {
    return false;
  }

  for (let between = comment.endLine + 1; between < line; between += 1) {
    if (valueLines.has(between)) {
      return false;
    }
  }

  return !valueLines.has(comment.line);
}

const unitLimitMs = 5000;
const slowTestsHint = 'find its cause in the "Slow tests" section of the testing skill and fix it';

function collectScriptFindings(
  path: string,
  text: string,
  limits: ReadonlyMap<string, number>,
): TestTimeoutFinding[] {
  const scripts = findMember(
    parseText(path, text, (input) => JSON.parse(input)),
    'scripts',
  );

  if (typeof scripts !== 'object' || scripts === null) {
    return [];
  }

  return Object.entries(scripts).flatMap(([name, command]: readonly [string, unknown]) => {
    if (typeof command !== 'string' || name === 'test:related') {
      return [];
    }

    const lane = name.startsWith('test:') ? name.slice('test:'.length) : null;
    const limit = pickLaneLimit(limits, lane);

    return collectTimeoutValues(command).flatMap((timeoutMs) => {
      if (timeoutMs === 0) {
        return [
          {
            path,
            message: `script "${name}" passes --timeout=0 to bun test, which turns the timeout off, past the ${limit.limitMs} ms limit of the ${limit.lane} lane; ${slowTestsHint}`,
          },
        ];
      }

      return timeoutMs > limit.limitMs
        ? [
            {
              path,
              message: `script "${name}" passes --timeout=${timeoutMs} to bun test, above the ${limit.limitMs} ms limit of the ${limit.lane} lane; ${slowTestsHint}`,
            },
          ]
        : [];
    });
  });
}

function findMember(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}

interface LaneLimit {
  readonly lane: string;
  readonly limitMs: number;
}

function pickLaneLimit(limits: ReadonlyMap<string, number>, lane: string | null): LaneLimit {
  const limitMs = lane === null ? undefined : limits.get(lane);

  return lane === null || limitMs === undefined
    ? { lane: 'unit', limitMs: unitLimitMs }
    : { lane, limitMs };
}

// A wrapper such as `bash with-home.sh bun test` runs the words after it, and these only print them.
const printCommands = new Set(['echo', 'printf']);

// The `bun test` options that need a value take the next word whole, even one that starts with
// `--timeout`, as `bun test --help` lists them.
const valueOptions = new Set([
  '-t',
  '--test-name-pattern',
  '--timeout',
  '--rerun-each',
  '--retry',
  '--seed',
  '--coverage-reporter',
  '--coverage-dir',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--path-ignore-patterns',
  '--parallel-delay',
  '--shard',
  '--timings',
]);

// `--timeout 20000` and `--timeout=20000` both reach `bun test`, and the shell removes any quotes or
// escapes from either form before Bun reads it. Bun reads each word after `--` as a file filter.
function collectTimeoutValues(command: string): number[] {
  const values: number[] = [];

  for (const words of collectShellCommands(parseShellWords(command))) {
    const name = words.find((word) => !word.isAssignment);

    if (name !== undefined && printCommands.has(name.text)) {
      continue;
    }

    const texts = words.map((word) => word.text);
    const start = findTestArgsStart(texts);

    if (start === null) {
      continue;
    }

    const args = texts.slice(start);

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';

      if (arg === '--') {
        break;
      }

      const value = arg === '--timeout' ? args[index + 1] : findTimeoutFlagValue(arg);
      const timeoutMs = value === undefined ? null : parseTimeoutMs(value);

      if (timeoutMs !== null) {
        values.push(timeoutMs);
      }

      if (valueOptions.has(arg)) {
        index += 1;
      }
    }
  }

  return values;
}

function collectShellCommands(words: readonly ShellWord[]): ShellWord[][] {
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

// Bun runs its test subcommand only when each option before it takes the `--name=value` form, so
// `bun --cwd pkg test` runs no test.
function findTestArgsStart(texts: readonly string[]): number | null {
  for (const [index, text] of texts.entries()) {
    const subcommand =
      text === 'bun' ? texts.findIndex((word, at) => at > index && !word.startsWith('-')) : -1;

    if (subcommand !== -1 && texts[subcommand] === 'test') {
      return subcommand + 1;
    }
  }

  return null;
}

function findTimeoutFlagValue(arg: string): string | undefined {
  return arg.startsWith('--timeout=') ? arg.slice('--timeout='.length) : undefined;
}

// Bun 1.4 reads digits and underscores, and `0` turns the timeout off. It runs an empty value with
// the default timeout, and refuses any other value before a test runs.
function parseTimeoutMs(value: string): number | null {
  return /^[\d_]+$/u.test(value) && /\d/u.test(value) ? Number(value.replaceAll('_', '')) : null;
}

function collectBunfigFindings(path: string, text: string, limit: LaneLimit): TestTimeoutFinding[] {
  const timeoutMs = findMember(
    findMember(
      parseText(path, text, (input) => Bun.TOML.parse(input)),
      'test',
    ),
    'timeout',
  );

  if (typeof timeoutMs !== 'number' || timeoutMs <= limit.limitMs) {
    return [];
  }

  return [
    {
      path,
      message: `[test] timeout = ${timeoutMs} raises every test above the ${limit.limitMs} ms limit of the ${limit.lane} lane; ${slowTestsHint}`,
    },
  ];
}

// git lists paths with forward slashes on every platform
function findDirectoryLane(path: string, appRoots: ReadonlySet<string>): string | null {
  const directories = posix.dirname(path).split('/');

  for (const [index, name] of directories.entries()) {
    const parent = index === 0 ? '.' : directories.slice(0, index).join('/');

    if (name === 'e2e' && (parent === '.' || appRoots.has(parent))) {
      return 'e2e';
    }

    if (name.endsWith('-e2e') && appRoots.has(directories.slice(0, index + 1).join('/'))) {
      return 'e2e';
    }
  }

  return null;
}

const guardedRules = ['zgeoff/max-test-timeout', 'zgeoff/test-timeout-exception-ticket'];
const ticketPattern = /\b[A-Z][A-Z0-9]*-\d+\b/u;

// a block comment's continuation stars are no evidence
const floorPattern = /\bfloor:[\s*]*[^\s*]/u;

function runCLI(): void {
  try {
    const findings = runTestTimeoutsCheck({ cwd: process.cwd(), env: process.env, runProgram });

    for (const finding of findings) {
      process.stdout.write(`${finding.path}: ${finding.message}\n`);
    }

    process.exitCode = findings.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `test-timeouts: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exitCode = 2;
  }
}

if (import.meta.main) {
  runCLI();
}
