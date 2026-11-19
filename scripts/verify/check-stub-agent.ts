import { access, constants } from 'node:fs/promises';
import { WringerError } from '@wringer/core';
import type { Endpoints } from '@wringer/core';
import { z } from 'zod';
import { parseRunEndpoints } from './run-endpoints.ts';

const claudeEntrySchema = z.object({ bin: z.string() });
const claudeBinSchema = z.object({ agents: z.object({ claude: claudeEntrySchema }) });

export async function checkStubAgent(endpoints: Endpoints): Promise<{ bin: string }> {
  const run = parseRunEndpoints(endpoints);

  const configText = await Bun.file(run.config).text();

  const config = claudeBinSchema.parse(JSON.parse(configText));
  const bin = config.agents.claude.bin;

  if (bin !== run.stub) {
    throw new WringerError('check-failed', {
      message: `agents.claude.bin is ${bin}, not the stand-in ${run.stub}`,
    });
  }

  const runnable = await access(bin, constants.X_OK).then(
    () => true,
    () => false,
  );

  if (!runnable) {
    throw new WringerError('check-failed', { message: `the stand-in ${bin} is not executable` });
  }

  return { bin };
}
