import { z } from 'zod';
import { DAEMON_STATE_SCHEMA } from './daemon-state-schema';
import { FLEET_BASE } from './fleet-base';
import { FLEET_PROCEDURE_SCOPES } from './fleet-procedure-scopes';

const STRINGS = z.array(z.string()).readonly();

const DAEMON_ENTRY = z.object({
  name: z.string(),
  state: DAEMON_STATE_SCHEMA,
  build: z.string().nullable(),
  daemonID: z.string(),
  features: STRINGS.optional(),
});

const DAEMONS_LIST_OUTPUT = z.object({
  daemons: z.array(DAEMON_ENTRY).readonly(),
  defaultDaemon: z.string(),
  build: z.string().optional(),
  contract: z.string().optional(),
});

export function buildDaemonsListProcedure() {
  return FLEET_BASE.meta({
    access: 'principal',
    readOnly: true,
    keyed: false,
    scope: FLEET_PROCEDURE_SCOPES['daemons.list'],
  })
    .input(z.object({}))
    .output(DAEMONS_LIST_OUTPUT);
}
