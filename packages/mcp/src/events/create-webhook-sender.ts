import { isIP } from 'node:net';
import { buildPinnedRequest } from './build-pinned-request';
import type { WebhookFailure, WebhookSender } from './types';

interface WebhookSenderDeps {
  readonly resolveHost: (hostname: string) => Promise<readonly string[]>;

  readonly isAllowedAddress: (address: string) => boolean;

  readonly transport: (target: string, init: BunFetchRequestInit) => Promise<Response>;

  readonly timeoutMs: number;
}

// Subscribers choose the callback host, so every address it resolves to must pass the policy
// before connecting; otherwise a subscriber could aim atc at a private network.
export function createWebhookSender(deps: WebhookSenderDeps): WebhookSender {
  return async (request) => {
    const url = new URL(request.url);

    if (url.protocol !== 'https:') {
      return { kind: 'failed', reason: 'connection_refused' };
    }

    const hostname = url.hostname.replace(/^\[(?<inner>.*)\]$/u, '$<inner>');
    const addresses = isIP(hostname) === 0 ? await tryResolve(deps, hostname) : [hostname];
    const [address] = addresses;

    if (
      address === undefined ||
      !addresses.every((candidate) => deps.isAllowedAddress(candidate))
    ) {
      return { kind: 'failed', reason: 'connection_refused' };
    }

    const pinned = buildPinnedRequest(request, address, AbortSignal.timeout(deps.timeoutMs));

    try {
      const response = await deps.transport(pinned.target, pinned.init);
      const body = await readBodyStart(response);

      return { kind: 'answered', status: response.status, body };
    } catch (error) {
      return { kind: 'failed', reason: pickFailure(error) };
    }
  };
}

async function tryResolve(deps: WebhookSenderDeps, hostname: string): Promise<readonly string[]> {
  try {
    return await deps.resolveHost(hostname);
  } catch {
    return [];
  }
}

// A verification answer holds a short challenge, so a longer body is cut.
const BODY_LIMIT = 4096;

async function readBodyStart(response: Response): Promise<string> {
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (size < BODY_LIMIT) {
    const read = await reader.read();

    if (read.done || !(read.value instanceof Uint8Array)) {
      break;
    }

    chunks.push(read.value);

    size += read.value.length;
  }

  await reader.cancel();

  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, BODY_LIMIT));
}

function pickFailure(error: unknown): WebhookFailure {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'timeout';
  }

  const code = error instanceof Error && 'code' in error ? String(error.code) : '';

  return /TLS|CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/u.test(code)
    ? 'tls_error'
    : 'connection_refused';
}
