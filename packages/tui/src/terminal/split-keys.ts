// Splits one input chunk into its key presses: an escape sequence, an escape followed by one
// character, a lone escape, or one character. The pieces join back into the chunk byte for byte.
export function splitKeys(chunk: Buffer): Buffer[] {
  const keys: Buffer[] = [];
  let start = 0;

  while (start < chunk.length) {
    const length = measureKey(chunk, start);

    keys.push(chunk.subarray(start, start + length));

    start += length;
  }

  return keys;
}

const ESC = 0x1b;
const CSI_OPENER = 0x5b;
const SS3_OPENER = 0x4f;

// OSC, DCS and APC, the string sequences a terminal answers with, so a late answer never reads as
// typed letters
const STRING_OPENERS = new Set([0x5d, 0x50, 0x5f]);

function measureKey(chunk: Buffer, start: number): number {
  if (chunk[start] !== ESC) {
    return Math.min(measureCharacter(chunk[start] ?? 0), chunk.length - start);
  }

  const next = chunk[start + 1];

  if (next === undefined || next === ESC) {
    return 1;
  }

  if (next === CSI_OPENER) {
    return measureCSI(chunk, start);
  }

  if (STRING_OPENERS.has(next)) {
    return measureString(chunk, start);
  }

  if (next === SS3_OPENER) {
    return Math.min(3, chunk.length - start);
  }

  return 1 + Math.min(measureCharacter(next), chunk.length - start - 1);
}

function measureCharacter(lead: number): number {
  if (lead >= 0xf0 && lead <= 0xf7) {
    return 4;
  }

  if (lead >= 0xe0) {
    return lead <= 0xef ? 3 : 1;
  }

  return lead >= 0xc0 ? 2 : 1;
}

// CSI parameters and intermediates run up to the final byte, in 0x40 to 0x7e
function measureCSI(chunk: Buffer, start: number): number {
  for (let index = start + 2; index < chunk.length; index += 1) {
    const byte = chunk[index] ?? 0;

    if (byte >= 0x40 && byte <= 0x7e) {
      return index - start + 1;
    }

    if (byte < 0x20 || byte > 0x3f) {
      return index - start;
    }
  }

  return chunk.length - start;
}

const BEL = 0x07;
const ST_FINAL = 0x5c;

// a string sequence ends at BEL, or at ESC \ (ST)
function measureString(chunk: Buffer, start: number): number {
  for (let index = start + 2; index < chunk.length; index += 1) {
    if (chunk[index] === BEL) {
      return index - start + 1;
    }

    if (chunk[index] === ESC && chunk[index + 1] === ST_FINAL) {
      return index - start + 2;
    }
  }

  return chunk.length - start;
}
