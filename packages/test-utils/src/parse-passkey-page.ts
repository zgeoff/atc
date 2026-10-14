import { z } from 'zod';

const REQUEST_OPTIONS = z.object({ challenge: z.string(), rpId: z.string() });

const CREATION_OPTIONS = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
});

const SIGN_IN = z.object({ mode: z.literal('get'), options: REQUEST_OPTIONS });
const ENROLLMENT = z.object({ mode: z.literal('create'), options: CREATION_OPTIONS });
const PASSKEY_PAGE = z.discriminatedUnion('mode', [SIGN_IN, ENROLLMENT]);

/**
 * The passkey ceremony an atc sign-in or enrollment page holds in its
 * `atc-passkey` JSON block: `get` with the request options of a sign-in,
 * or `create` with the creation options of an enrollment. Throws when the
 * page holds no such block or the block is not one of the two.
 */
export function parsePasskeyPage(html: string): z.infer<typeof PASSKEY_PAGE> {
  const block = /<script type="application\/json" id="atc-passkey">(?<json>[^<]*)<\/script>/u.exec(
    html,
  )?.groups?.['json'];

  if (block === undefined) {
    throw new Error('the page holds no passkey ceremony');
  }

  return PASSKEY_PAGE.parse(JSON.parse(block));
}
