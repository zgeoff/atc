import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { answerSubscribeRequest } from './answer-subscribe-request';
import type { EventMethodDeps } from './answer-subscribe-request';
import { UNSUBSCRIBE_PARAMS, answerUnsubscribeRequest } from './answer-unsubscribe-request';
import { EVENT_INPUT_SCHEMA, EVENT_PAYLOAD_SCHEMA, EVENT_TYPES } from './event-types';
import { SUBSCRIBE_PARAMS } from './parse-subscribe-request';

// ChatGPT reads the top-level `events` key of the sketch that came before the
// draft extension, which the SDK's capability type does not know.
const SKETCH_CAPABILITIES = { events: {} };

export function registerEventMethods(server: McpServer, deps: EventMethodDeps): void {
  server.server.registerCapabilities({
    extensions: { 'io.modelcontextprotocol/events': {} },
    ...SKETCH_CAPABILITIES,
  });

  server.server.setRequestHandler('events/list', { params: z.looseObject({}) }, () => ({
    events: EVENT_TYPES.map((type) => ({
      name: type.name,
      description: type.description,
      delivery: ['webhook'],
      inputSchema: EVENT_INPUT_SCHEMA,
      payloadSchema: EVENT_PAYLOAD_SCHEMA,
    })),
  }));

  server.server.setRequestHandler('events/subscribe', { params: SUBSCRIBE_PARAMS }, (params) =>
    answerSubscribeRequest(deps, params),
  );

  server.server.setRequestHandler('events/unsubscribe', { params: UNSUBSCRIBE_PARAMS }, (params) =>
    answerUnsubscribeRequest(deps, params),
  );
}
