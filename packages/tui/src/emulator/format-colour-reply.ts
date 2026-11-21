import type { RGB } from '../compositor/types';

// The answer to an OSC 10 or OSC 11 query, with each channel as 16 bits, as xterm answers.
export function formatColourReply(code: 10 | 11, colour: RGB): string {
  return `\u001B]${code};rgb:${toHex16(colour.red)}/${toHex16(colour.green)}/${toHex16(colour.blue)}\u001B\\`;
}

function toHex16(channel: number): string {
  return (channel * 257).toString(16).padStart(4, '0');
}
