/**
 * Splits one stream of newline-framed text into whole lines. Bytes decode
 * as UTF-8 with state kept across reads, so a multi-byte character split
 * between two reads decodes whole. The unterminated tail waits for the read
 * that ends it, and a line holding only whitespace is dropped. A carriage
 * return before the newline stays on the line.
 */
export class LineDecoder {
  private readonly decoder = new TextDecoder();

  private pending = '';

  get pendingLength(): number {
    return this.pending.length;
  }

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a socket read buffer has no readonly form
  splitChunk(bytes: Uint8Array): string[] {
    return this.splitText(this.decodeText(bytes));
  }

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a socket read buffer has no readonly form
  decodeText(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  splitText(text: string): string[] {
    const lines = `${this.pending}${text}`.split('\n');

    this.pending = lines.pop() ?? '';

    return lines.filter((line) => line.trim() !== '');
  }
}
