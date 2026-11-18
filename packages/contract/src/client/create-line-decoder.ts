export interface LineDecoder {
  readonly pendingLength: number;
  readonly splitChunk: (bytes: Uint8Array) => string[];
  readonly decodeText: (bytes: Uint8Array) => string;
  readonly splitText: (text: string) => string[];
}

export function createLineDecoder(): LineDecoder {
  const decoder = new TextDecoder();

  let pending = '';
  const decodeText = (bytes: Uint8Array) => decoder.decode(bytes, { stream: true });

  const splitText = (text: string) => {
    const lines = `${pending}${text}`.split('\n');

    pending = lines.pop() ?? '';

    return lines.filter((line) => line.trim() !== '');
  };

  return {
    get pendingLength() {
      return pending.length;
    },
    splitChunk: (bytes) => splitText(decodeText(bytes)),
    decodeText,
    splitText,
  };
}
