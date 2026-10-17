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

export async function runCommandLine(
  argv: readonly string[],
  entry: Command,
  tree: CommandTree,
  io: CommandLineIO,
): Promise<void> {
  let refusedPath: readonly string[] = [];

  const options = {
    name: tree.name,
    version: tree.version,
    description: tree.description,
    subCommands: { ...tree.subCommands },
    strict: true,
    usageSilent: true,
    renderHeader: null,
  };

  try {
    const shown = await cli([...argv], entry, {
      ...options,
      renderValidationErrors: (ctx) => {
        refusedPath = ctx.commandPath;

        return Promise.resolve('');
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

    if (tree.lenient?.has(refusedPath[0] ?? '') === true) {
      io.printError(`${tree.name} ${refusedPath.join(' ')}: ${formatReasons(error)}`);
      io.exit(0);

      return;
    }

    // The usage `--help` prints for the refused command, which lists the
    // commands below it where a name was not found.
    const usage = await cli([...refusedPath, '--help'], entry, options);

    io.print(`${usage ?? ''}\n`);
    io.printError(formatReasons(error));
    io.exit(1);
  }
}

export function makeMissingCommandRun(io: CommandLineIO) {
  return async (ctx: Readonly<CommandContext>): Promise<void> => {
    io.print(`${await renderCommandUsage(ctx)}\n`);
    io.printError('No command specified.');
    io.exit(1);
  };
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
