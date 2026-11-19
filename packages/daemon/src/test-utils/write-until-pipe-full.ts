import { closeSync, constants, openSync, writeSync } from 'node:fs';

// The pipe takes the large writes first, then single bytes, since a
// non-blocking write that does not fit whole takes nothing.
const CHUNK = Buffer.alloc(4096, 'x');
const BYTE = Buffer.from('x');

export function writeUntilPipeFull(fifoPath: string): number {
  const fd = openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK);

  try {
    return writeUntilRefused(fd, CHUNK) + writeUntilRefused(fd, BYTE);
  } finally {
    closeSync(fd);
  }
}

function writeUntilRefused(fd: number, chunk: Buffer): number {
  let written = 0;

  for (;;) {
    try {
      written += writeSync(fd, chunk);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EAGAIN') {
        return written;
      }

      throw error;
    }
  }
}
