import type { RGB } from '../compositor/types';

const RGB_ANSWER = /^rgb:(?<red>[0-9a-f]{1,4})\/(?<green>[0-9a-f]{1,4})\/(?<blue>[0-9a-f]{1,4})$/iu;
const HASH_ANSWER = /^#(?<digits>[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{9}|[0-9a-f]{12})$/iu;

// The colour an OSC 10 or OSC 11 answer carries: `rgb:` with one to four hex digits a channel, or
// `#` with the same count of digits for each of three channels.
export function parseColourAnswer(data: string): RGB | null {
  const rgb = RGB_ANSWER.exec(data)?.groups;

  if (rgb !== undefined) {
    return {
      red: scaleChannel(rgb['red']),
      green: scaleChannel(rgb['green']),
      blue: scaleChannel(rgb['blue']),
    };
  }

  const digits = HASH_ANSWER.exec(data)?.groups?.['digits'];

  if (digits === undefined) {
    return null;
  }

  const width = digits.length / 3;

  return {
    red: scaleChannel(digits.slice(0, width)),
    green: scaleChannel(digits.slice(width, width * 2)),
    blue: scaleChannel(digits.slice(width * 2)),
  };
}

function scaleChannel(hex = '0'): number {
  const max = 16 ** hex.length - 1;

  return Math.round((Number.parseInt(hex, 16) / max) * 255);
}
