import { WringerError } from '@wringer/core';
import type { MCPClient } from '@wringer/mcp';

// The doctor's check that the target's service client signs in to each HTTP server: the mcp driver
// trades its ID and secret for an access token, and lists the tools with it.
export async function checkMCPSignIn(
  mcp: Pick<MCPClient, 'tools'>,
  servers: readonly string[],
): Promise<{ servers: Record<string, number> }> {
  const counts: Record<string, number> = {};

  for (const server of servers) {
    const answer = await mcp.tools({ server }).catch((error: unknown) => {
      if (error instanceof WringerError) {
        throw new WringerError('check-failed', {
          message: `the service client did not sign in to ${server}: ${error.message}`,
          hint:
            error.hint ?? 'Read the message, fix its cause, then run `bun verify doctor` again.',
        });
      }

      throw error;
    });

    counts[server] = answer.tools.length;
  }

  return { servers: counts };
}
