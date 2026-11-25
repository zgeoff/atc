import { z } from 'zod';
import { AGENT_LIST_SCHEMA } from '../config/agent-list';
import { REQUEST_PARAM_SCHEMAS } from '../daemon-contract/request-param-schemas';
import { EVENTS_PAGE_SCHEMA } from '../daemon-events/events-page-schema';
import { FLEET_EVENT_SCHEMA } from '../daemon-events/fleet-event-schema';
import { SESSION_DESCRIPTOR_SCHEMA } from '../sessions/session-descriptor';
import { buildSessionAnswers } from './build-session-answers';

const ANSWERS = buildSessionAnswers(SESSION_DESCRIPTOR_SCHEMA);

// One daemon's answers and inputs.
export const DAEMON_SHAPES = {
  daemonInput: {},
  spawnInput: { parent: REQUEST_PARAM_SCHEMAS['session.spawn'].shape.parent },
  eventsCursor: REQUEST_PARAM_SCHEMAS['events.read'].shape.cursor,
  sessionList: z.object({ sessions: ANSWERS.list }),
  spawn: ANSWERS.spawn,
  sessionGet: ANSWERS.get,
  agentsList: AGENT_LIST_SCHEMA,
  eventsPage: EVENTS_PAGE_SCHEMA,
  streamEvent: FLEET_EVENT_SCHEMA,
  extraProcedures: {},
};
