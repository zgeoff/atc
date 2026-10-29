import type { TranscriptWindow } from './load-transcript-page';

export async function readLocalTranscriptWindow(
  path: string,
  offset: number,
  length: number,
): Promise<TranscriptWindow | null> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return null;
  }

  const size = file.size;

  const bytes = await file.slice(offset, Math.min(offset + length, size)).bytes();

  return { size, bytes };
}
