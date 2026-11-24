import { z } from 'zod';
import { AGENT_LIST_SCHEMA } from '../config/agent-list';
import { FLEET_EVENT_SCHEMA } from '../daemon-events/fleet-event-schema';
import { GATEWAY_SESSION_ID_SCHEMA } from '../ids/gateway-session-id-schema';
import { SESSION_DESCRIPTOR_SCHEMA } from '../sessions/session-descriptor';
import { buildDaemonsListProcedure } from './build-daemons-list-procedure';
import { buildSessionAnswers } from './build-session-answers';
import { DAEMON_STATE_SCHEMA } from './daemon-state-schema';
import { FLEET_LOCATOR_SCHEMA } from './fleet-locator-schema';

const GATEWAY_DESCRIPTOR_SCHEMA = SESSION_DESCRIPTOR_SCHEMA.extend({
  id: GATEWAY_SESSION_ID_SCHEMA,
  parent: GATEWAY_SESSION_ID_SCHEMA.optional(),
  locator: FLEET_LOCATOR_SCHEMA,
});

const ANSWERS = buildSessionAnswers(GATEWAY_DESCRIPTOR_SCHEMA);
const STRINGS = z.array(z.string()).readonly();

const ORIGIN_SCHEMA = z.object({
  daemon: z.string(),
  incarnation: z.string(),
  cursor: z.string(),
});

const GATEWAY_EVENT_SCHEMA = FLEET_EVENT_SCHEMA.extend({
  origin: ORIGIN_SCHEMA,
  note: z.string().optional(),
  answer: z.string().optional(),
});

const DAEMON_STATE_ENTRY = z.object({
  name: z.string(),
  state: DAEMON_STATE_SCHEMA,
});

const UP_AGENTS = AGENT_LIST_SCHEMA.extend({ state: z.literal('up') });

const AGENTS_BY_STATE = z.union([
  UP_AGENTS,
  z.object({ state: DAEMON_STATE_SCHEMA.exclude(['up']) }),
]);

// The gateway's answers and inputs.
export const GATEWAY_SHAPES = {
  daemonInput: {
    daemon: z
      .string({ error: 'daemon must be a daemon name' })
      .min(1, 'daemon must be a daemon name')
      .optional(),
  },
  spawnInput: {},
  sessionList: z.object({
    sessions: ANSWERS.list,
    daemons: z.array(DAEMON_STATE_ENTRY).readonly(),
  }),
  spawn: ANSWERS.spawn,
  sessionGet: ANSWERS.get,
  agentsList: z.object({ daemons: z.record(z.string(), AGENTS_BY_STATE) }),
  eventsPage: z.object({
    events: z.array(GATEWAY_EVENT_SCHEMA).readonly(),
    cursor: z.string(),
    more: z.boolean(),
    unavailable: STRINGS,
    started: STRINGS,
    truncated: STRINGS,
  }),
  extraProcedures: { daemons: { list: buildDaemonsListProcedure() } },
};
