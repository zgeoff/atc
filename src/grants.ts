import { bootDaemonClient } from './client/boot-daemon';
import { isRecord } from './shared/report';

/**
 * Runs `atc grants`: lists the grants remote MCP clients hold, or revokes one
 * by id. A revoked grant's tokens stop working on the client's next request.
 */
export async function runGrants(revoke: string | null): Promise<void> {
  const boot = await bootDaemonClient();

  try {
    if (revoke !== null) {
      await boot.client.sendRequest('grant.revoke', { grant: revoke });

      console.log(`revoked ${revoke}`);

      return;
    }

    const listed = await boot.client.sendRequest('grant.list');

    const grants = Array.isArray(listed['grants']) ? listed['grants'] : [];

    if (grants.length === 0) {
      console.log('no grants');

      return;
    }

    for (const grant of grants) {
      console.log(formatGrant(grant));
    }
  } finally {
    boot.client.stop();
  }
}

function formatGrant(grant: unknown): string {
  if (!isRecord(grant)) {
    return '';
  }

  const scopes = Array.isArray(grant['scopes']) ? grant['scopes'].join(' ') : '';

  const lastUsed =
    typeof grant['lastUsedAt'] === 'number' ? formatTime(grant['lastUsedAt']) : 'never';

  const created = typeof grant['createdAt'] === 'number' ? formatTime(grant['createdAt']) : '';

  return `${String(grant['id'])}  ${String(grant['clientName'])}  [${scopes}]  created ${created}  last used ${lastUsed}`;
}

function formatTime(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16);
}
