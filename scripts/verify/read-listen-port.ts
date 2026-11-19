import { z } from 'zod';

const daemonRecordSchema = z.object({ listenPort: z.number().int().min(1).max(65_535) });

export async function readListenPort(recordFile: string): Promise<number> {
  const text = await Bun.file(recordFile).text();

  return daemonRecordSchema.parse(JSON.parse(text)).listenPort;
}
