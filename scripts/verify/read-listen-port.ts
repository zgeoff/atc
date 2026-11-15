import { z } from 'zod';

const daemonRecordSchema = z.object({ listenPort: z.number().int().min(1).max(65_535) });

// The port the daemon's TCP listener bound for `--listen 127.0.0.1:0`, from the record the daemon
// writes into its state folder.
export async function readListenPort(recordFile: string): Promise<number> {
  const text = await Bun.file(recordFile).text();

  return daemonRecordSchema.parse(JSON.parse(text)).listenPort;
}
