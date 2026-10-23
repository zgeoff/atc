import { z } from 'zod';
import type { EventMethodDeps } from './answer-subscribe-request';
import { buildSubscriptionID } from './build-subscription-id';

// ChatGPT names the subscription by the key it subscribed with, not by its id.
export const UNSUBSCRIBE_PARAMS = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.looseObject({ mode: z.string(), url: z.string() }),
});

// An unsubscribe ends the subscription its key derives, and answers the same
// whether one existed or not, so a client can repeat it safely. Subscribe
// stores only subscriptions without arguments, so a key with arguments ends none.
export async function answerUnsubscribeRequest(
  deps: Pick<EventMethodDeps, 'db' | 'clientID'>,
  params: z.infer<typeof UNSUBSCRIBE_PARAMS>,
): Promise<Readonly<Record<string, never>>> {
  if (Object.keys(params.arguments ?? {}).length > 0) {
    return {};
  }

  const id = buildSubscriptionID({
    clientID: deps.clientID,
    url: params.delivery.url,
    name: params.name,
    arguments: '{}',
  });

  await deps.db
    .deleteFrom('atc_event_subscription')
    .where('id', '=', id)
    .where('client_id', '=', deps.clientID)
    .execute();

  return {};
}
