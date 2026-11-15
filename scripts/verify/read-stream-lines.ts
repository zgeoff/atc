import type { StreamClient } from '@wringer/stream';

// Every line the stream with the name recorded since `use` last marked it, page by page.
export async function readStreamLines(client: StreamClient, name: string): Promise<string[]> {
  const lines: string[] = [];
  let from: number | undefined;

  for (;;) {
    const slice = await client.read({ name, ...(from === undefined ? {} : { from }) });

    lines.push(...slice.records.map((record) => record.line));

    if (!slice.more) {
      return lines;
    }

    from = slice.cursor;
  }
}
