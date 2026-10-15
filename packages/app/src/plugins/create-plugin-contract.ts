import type { HostServices, PluginContext, PluginDefinition, PluginKind } from '@atc/plugin-api';

interface PluginContractArgs<K extends PluginKind, C> {
  readonly plugin: PluginDefinition<K, C>;

  // The config slice the plugin reads, and the id of the entry it belongs
  // to.
  readonly raw: unknown;
  readonly entryID: string;
  readonly host: HostServices;
  readonly context: PluginContext;
}

/**
 * The contract a plugin creates from a config slice the host built: the
 * slice parses through the plugin's schema, then the plugin's factory runs.
 * Throws when the slice does not parse, which only a host bug causes, and
 * whatever the factory throws.
 */
export function createPluginContract<K extends PluginKind, C>(
  args: PluginContractArgs<K, C>,
): ReturnType<PluginDefinition<K, C>['create']> {
  const schema = args.plugin.configSchema({
    ...args.context,
    entryID: args.entryID,
    foreignFields: new Set(),
  });

  return args.plugin.create(schema.parse(args.raw), args.host, args.context);
}
