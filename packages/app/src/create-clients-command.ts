import { define, lazy } from 'gunshi';
import type { Args } from 'gunshi';
import type { ClientsAction } from './clients';

interface ClientsCommandSpec {
  // What the clients connect to, such as `atc mcp --http`.
  readonly server: string;

  // The flags every subcommand takes beside its own.
  readonly args: Args;
  readonly runClients: (
    action: ClientsAction,
    values: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
}

export function createClientsCommand(spec: ClientsCommandSpec) {
  return define({
    name: 'clients',
    description: `List, add, or remove the clients that may connect to ${spec.server}`,
    args: spec.args,
    subCommands: {
      list: lazy(
        () => async (ctx) => {
          await spec.runClients({ kind: 'list' }, ctx.values);
        },
        { name: 'list', description: 'List the clients', internal: true, args: spec.args },
      ),
      add: lazy(
        () => async (ctx) => {
          await spec.runClients(
            { kind: 'add', name: ctx.values.name, redirectURIs: ctx.values['redirect-uri'] },
            ctx.values,
          );
        },
        {
          name: 'add',
          description: 'Add a client and print its client ID',
          args: {
            name: { type: 'positional', description: 'The client name' },
            'redirect-uri': {
              type: 'string',
              multiple: true,
              required: true,
              description: 'A redirect URI the client returns to; repeat for more',
            },
            ...spec.args,
          },
        },
      ),
      remove: lazy(
        () => async (ctx) => {
          await spec.runClients({ kind: 'remove', clientID: ctx.values.id }, ctx.values);
        },
        {
          name: 'remove',
          description: 'Remove a client and revoke every grant it holds',
          args: { id: { type: 'positional', description: 'The client ID' }, ...spec.args },
        },
      ),
    },
    run: async (ctx) => {
      await spec.runClients({ kind: 'list' }, ctx.values);
    },
  });
}
