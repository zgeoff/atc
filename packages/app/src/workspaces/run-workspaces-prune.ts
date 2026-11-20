import type { DaemonClient } from '@atc/protocol/client';
import { WORKSPACE_PRUNE_SCHEMA } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import { PROCESS_IO } from '../cli/process-io';
import type { ProcessIO } from '../cli/process-io';
import { formatPruneReport } from './format-prune-report';

interface RunWorkspacesPruneOptions {
  readonly remove: boolean;
  readonly io?: Pick<ProcessIO, 'print' | 'printError'>;
}

export async function runWorkspacesPrune(
  client: Pick<DaemonClient, 'sendRequest'>,
  options: RunWorkspacesPruneOptions,
): Promise<number> {
  const io = options.io ?? PROCESS_IO;

  try {
    const answer = await client.sendRequest('workspaces.prune', { remove: options.remove });

    const prune = WORKSPACE_PRUNE_SCHEMA.parse(answer);

    for (const line of formatPruneReport(prune)) {
      io.print(line);
    }

    return 0;
  } catch (error) {
    const code = error instanceof AtcError ? `${error.code}: ` : '';

    io.printError(
      `atc workspaces prune: ${code}${error instanceof Error ? error.message : String(error)}`,
    );

    return 1;
  }
}
