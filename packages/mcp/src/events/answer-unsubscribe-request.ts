import { z } from 'zod';
import type { EventMethodDeps } from './answer-subscribe-request';
import { buildSubscriptionID } from './build-subscription-id';
import { createSubscriptionStore } from './create-subscription-store';

// ChatGPT names the subscription by the key it subscribed with, not by its id.
export const UNSUBSCRIBE_PARAMS = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.looseObject({ mode: z.string(), url: z.string() }),
});

// Subscribe stores only subscriptions without arguments, so a key with
// arguments ends none.
export async function answerUnsubscribeRequest(
  deps: Pick<EventMethodDeps, 'db' | 'clientID' | 'deliverer'>,
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

  await createSubscriptionStore(deps.db).end(id);

  deps.deliverer.retire(id);

  return {};
}
