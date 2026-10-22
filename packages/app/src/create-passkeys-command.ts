import { define, lazy } from 'gunshi';
import type { Args } from 'gunshi';
import type { PasskeysAction } from './passkeys';

interface PasskeysCommandSpec {
  // What the owner signs in to, such as `atc mcp --http`.
  readonly server: string;

  // The flags every subcommand takes beside its own.
  readonly args: Args;
  readonly runPasskeys: (
    action: PasskeysAction,
    values: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
}

export function createPasskeysCommand(spec: PasskeysCommandSpec) {
  return define({
    name: 'passkeys',
    description: `List, enroll, or remove the passkeys the owner signs in to ${spec.server} with`,
    args: spec.args,
    subCommands: {
      list: lazy(
        () => async (ctx) => {
          await spec.runPasskeys({ kind: 'list' }, ctx.values);
        },
        {
          name: 'list',
          description: 'List the enrolled passkeys',
          internal: true,
          args: spec.args,
        },
      ),
      enroll: lazy(
        () => async (ctx) => {
          await spec.runPasskeys({ kind: 'enroll', reset: ctx.values.reset === true }, ctx.values);
        },
        {
          name: 'enroll',
          description:
            'Print a one-time token that enrolls a passkey; --reset first removes every passkey',
          args: {
            reset: {
              type: 'boolean',
              description: 'Remove every passkey and browser sign-in first, after losing them',
            },
            ...spec.args,
          },
        },
      ),
      remove: lazy(
        () => async (ctx) => {
          await spec.runPasskeys({ kind: 'remove', id: ctx.values.id }, ctx.values);
        },
        {
          name: 'remove',
          description: 'Remove a passkey, such as a lost one',
          args: { id: { type: 'positional', description: 'The passkey ID' }, ...spec.args },
        },
      ),
    },
    run: async (ctx) => {
      await spec.runPasskeys({ kind: 'list' }, ctx.values);
    },
  });
}
