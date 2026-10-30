import { z } from 'zod';
import { MAX_EVENTS_CURSOR_BYTES } from './max-events-cursor-bytes';
import { MAX_REGISTRY_DAEMONS } from './max-registry-daemons';

// A daemon name: never a `.`, which separates the parts of a gateway id.
const DAEMON_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/u;

// `<host>:<port>`, with an IPv6 host in brackets.
const ADDRESS_PATTERN = /^(?:\[(?<v6>[^\]]+)\]|(?<host>[^:[\]]+)):(?<port>\d{1,5})$/u;
const ADDRESS_MESSAGE = 'needs an address of <host>:<port> with a port from 1 to 65535';

const ADDRESS_SCHEMA = z.string({ error: ADDRESS_MESSAGE }).transform((raw, ctx) => {
  const groups = ADDRESS_PATTERN.exec(raw)?.groups;
  const host = groups?.['v6'] ?? groups?.['host'];
  const port = Number(groups?.['port']);

  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    ctx.issues.push({ code: 'custom', message: ADDRESS_MESSAGE, input: raw });

    return z.NEVER;
  }

  return { host, port };
});

const DAEMON_ID_MESSAGE = 'needs the daemonID that atc daemon id prints on its host';

// A daemon ID as a daemon mints it: a lowercase UUID.
const DAEMON_ID_SCHEMA = z
  .string({ error: DAEMON_ID_MESSAGE })
  .regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u, DAEMON_ID_MESSAGE);

const DAEMON_SCHEMA = z.object(
  { address: ADDRESS_SCHEMA, daemonID: DAEMON_ID_SCHEMA },
  { error: 'must be an object with address and daemonID' },
);

// The gateway's registry file. Each daemon's bearer token stays out of it, in
// the gateway's environment.
export const GATEWAY_REGISTRY_SCHEMA = z
  .object(
    {
      daemons: z.record(z.string().regex(DAEMON_NAME_PATTERN), DAEMON_SCHEMA, {
        error: (issue) =>
          issue.code === 'invalid_key'
            ? `must match ${DAEMON_NAME_PATTERN.source}`
            : 'the registry must be an object whose daemons is an object',
      }),
      defaultDaemon: z.string({
        error: 'defaultDaemon is required and must name a daemon in the registry',
      }),
    },
    { error: 'the registry must be an object whose daemons is an object' },
  )
  .superRefine((registry, ctx) => {
    const count = Object.keys(registry.daemons).length;

    if (count === 0) {
      ctx.addIssue({ code: 'custom', path: ['daemons'], message: 'the registry lists no daemon' });
    }

    if (count > MAX_REGISTRY_DAEMONS) {
      ctx.addIssue({
        code: 'custom',
        path: ['daemons'],
        message: `the registry lists ${count} daemons, over the limit of ${MAX_REGISTRY_DAEMONS}, the most whose events cursor fits ${MAX_EVENTS_CURSOR_BYTES} bytes`,
      });
    }

    if (!Object.hasOwn(registry.daemons, registry.defaultDaemon)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultDaemon'],
        message: `defaultDaemon '${registry.defaultDaemon}' is not a daemon in the registry`,
      });
    }
  });
