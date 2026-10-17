export class LineDecoder {
  private readonly decoder = new TextDecoder();

  private pending = '';

  get pendingLength(): number {
    return this.pending.length;
  }

  splitChunk(bytes: Uint8Array): string[] {
    return this.splitText(this.decodeText(bytes));
  }

  decodeText(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  splitText(text: string): string[] {
    const lines = `${this.pending}${text}`.split('\n');

    this.pending = lines.pop() ?? '';

    return lines.filter((line) => line.trim() !== '');
  }
}
