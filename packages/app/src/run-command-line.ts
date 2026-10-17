import {
  cli,
  isArgsValidationError,
  isCommandNotFoundError,
  isCommandResolutionError,
} from 'gunshi';
import type { Command, CommandContext, SubCommandable } from 'gunshi';

// What a command line writes to and how it ends: the console and the exit.
export interface CommandLineIO {
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly exit: (code: number) => void;
}

// A binary's command tree, below its entry command, and how the binary
// presents itself in usage.
export interface CommandTree {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly subCommands: Readonly<Record<string, SubCommandable>>;

  // The commands that exit 0 on a command line they refuse, by the name
  // that leads to them, such as a reporter that runs inside a session.
  readonly lenient?: ReadonlySet<string>;
}

/**
 * Runs a command line through its command tree. Every command refuses a
 * flag it does not declare. `--help` prints the usage of the command it
 * follows and `--version` prints the version, each then exiting 0. A
 * command line the parser refuses prints the refused command's usage and
 * every reason, then exits 1, or exits 0 for a lenient command.
 */
export async function runCommandLine(
  argv: readonly string[],
  entry: Command,
  tree: CommandTree,
  io: CommandLineIO,
): Promise<void> {
  let refused: RefusedCommand = { path: [], usage: '' };

  try {
    const shown = await cli([...argv], entry, {
      name: tree.name,
      version: tree.version,
      description: tree.description,
      subCommands: { ...tree.subCommands },
      strict: true,
      usageSilent: true,
      renderHeader: null,
      renderValidationErrors: async (ctx) => {
        refused = { path: ctx.commandPath, usage: await renderCommandUsage(ctx) };

        return '';
      },
    });

    if (shown !== undefined) {
      io.print(shown);
      io.exit(0);
    }
  } catch (error) {
    if (!isRefusedCommandLine(error)) {
      throw error;
    }

    if (tree.lenient?.has(refused.path[0] ?? '') === true) {
      io.printError(`${tree.name} ${refused.path.join(' ')}: ${formatReasons(error)}`);
      io.exit(0);

      return;
    }

    io.print(`${refused.usage}\n`);
    io.printError(formatReasons(error));
    io.exit(1);
  }
}

/**
 * The runner of a command that only groups others: it prints its usage and
 * exits 1, since the command line names none of them.
 */
export function makeMissingCommandRun(io: CommandLineIO) {
  return async (ctx: Readonly<CommandContext>): Promise<void> => {
    io.print(`${await renderCommandUsage(ctx)}\n`);
    io.printError('No command specified.');
    io.exit(1);
  };
}

interface RefusedCommand {
  readonly path: readonly string[];
  readonly usage: string;
}

function renderCommandUsage(ctx: Readonly<CommandContext>): Promise<string> {
  return ctx.env.renderUsage?.(ctx) ?? Promise.resolve('');
}

// The parser throws one error that holds every reason it refused the command
// line, and nothing else it throws is a usage error.
function isRefusedCommandLine(error: unknown): error is AggregateError {
  return (
    error instanceof AggregateError &&
    error.errors.every(
      (reason) =>
        isArgsValidationError(reason) ||
        isCommandNotFoundError(reason) ||
        isCommandResolutionError(reason),
    )
  );
}

function formatReasons(error: AggregateError): string {
  return error.errors
    .map((reason: unknown) => (reason instanceof Error ? reason.message : String(reason)))
    .join('\n');
}
