// names without their leading dashes
export interface GatewayFlags {
  readonly values: ReadonlySet<string>;
  readonly switches: ReadonlySet<string>;
}

type ParsedStateDir =
  | { readonly ok: true; readonly stateDir: string | null }
  | { readonly ok: false; readonly message: string };

// A flag: one or two dashes, a name, and an optional `=<value>`. A lone `-`
// is a positional.
const FLAG_PATTERN = /^--?(?<name>[^=]+)(?:=(?<value>[\s\S]*))?$/u;

export function parseGatewayStateDir(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  flags: GatewayFlags,
): ParsedStateDir {
  const given: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';

    if (token === '--') {
      break;
    }

    const match = FLAG_PATTERN.exec(token);

    if (match === null) {
      continue;
    }

    const name = match.groups?.['name'] ?? '';
    const inline = match.groups?.['value'];

    // a token this cannot read for sure is refused, since reading it either way
    // could pick the wrong directory
    if (flags.switches.has(name)) {
      if (inline !== undefined) {
        return { ok: false, message: `${token} takes no value` };
      }

      continue;
    }

    if (!flags.values.has(name)) {
      return { ok: false, message: `unknown flag '${token}'` };
    }

    const value = inline ?? argv[i + 1];

    if (inline === undefined) {
      i++;
    }

    if (value === undefined || value === '' || (inline === undefined && value.startsWith('-'))) {
      return { ok: false, message: `--${name} needs a value; write --${name}=<value>` };
    }

    if (name === 'state-dir') {
      given.push(value);
    }
  }

  const distinct = [...new Set(given)];

  if (distinct.length > 1) {
    return {
      ok: false,
      message: `--state-dir gives different directories: ${distinct.map((dir) => `'${dir}'`).join(', ')}`,
    };
  }

  const fromEnv = env['ATC_GATEWAY_STATE_DIR'];

  return {
    ok: true,
    stateDir: distinct[0] ?? (fromEnv === undefined || fromEnv === '' ? null : fromEnv),
  };
}
