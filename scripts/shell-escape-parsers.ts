interface ShellEscape {
  readonly text: string;
  readonly length: number;
  readonly isQuoting: boolean;
}

export type ShellEscapeParser = (command: string, index: number) => ShellEscape;

// One parser for each escape rule of the Bash manual's Quoting section, typed over every rule, so a
// rule without a parser fails the type check.
export const shellEscapeParsers: Readonly<
  Record<
    'code' | 'backtick' | 'quoted-backtick' | 'literal' | 'double-quote' | 'ansi-c',
    ShellEscapeParser
  >
> = {
  code: parseCodeEscape,
  backtick: makeBacktickEscapeParser('$`\\'),
  'quoted-backtick': makeBacktickEscapeParser('$`\\"'),
  literal: parseLiteralEscape,
  'double-quote': parseDoubleQuotedEscape,
  'ansi-c': parseANSICEscape,
};

// Outside quotes, a backslash keeps the next character literal, and before a newline it joins the
// two lines.
function parseCodeEscape(command: string, index: number): ShellEscape {
  const escaped = command.charAt(index + 1);

  if (escaped === '') {
    return { text: '\\', length: 1, isQuoting: false };
  }

  return escaped === '\n'
    ? { text: '', length: 2, isQuoting: false }
    : { text: escaped, length: 2, isQuoting: true };
}

// The shell reads a backtick substitution twice. The first read turns a backslash and a character
// in `escapable` into that character, and the second read parses the result as code.
function makeBacktickEscapeParser(escapable: string): ShellEscapeParser {
  return (command, index) => {
    const first = readFirstPass(command, index, escapable);

    if (first.length === 1) {
      return parseCodeEscape(command, index);
    }

    // A nested backtick needs both reads to open, so it stays text.
    if (first.text === '`') {
      return { text: '`', length: 2, isQuoting: true };
    }

    if (first.text !== '\\') {
      return { text: '', length: 1, isQuoting: false };
    }

    const next = readFirstPass(command, index + 2, escapable);

    if (next.text === '') {
      return { text: '\\', length: 2, isQuoting: false };
    }

    return next.text === '\n'
      ? { text: '', length: 2 + next.length, isQuoting: false }
      : { text: next.text, length: 2 + next.length, isQuoting: true };
  };
}

function readFirstPass(
  command: string,
  index: number,
  escapable: string,
): { readonly text: string; readonly length: number } {
  const character = command.charAt(index);
  const escaped = command.charAt(index + 1);

  return character === '\\' && escaped !== '' && escapable.includes(escaped)
    ? { text: escaped, length: 2 }
    : { text: character, length: 1 };
}

// Single quotes hold no escape, so a backslash there is text.
function parseLiteralEscape(): ShellEscape {
  return { text: '\\', length: 1, isQuoting: false };
}

const doubleQuotedEscapable = '$`"\\\n';

// Inside double quotes, a backslash escapes only `$`, a backtick, `"`, `\` and a newline, and stays
// before any other character.
function parseDoubleQuotedEscape(command: string, index: number): ShellEscape {
  const escaped = command.charAt(index + 1);

  if (escaped === '' || !doubleQuotedEscapable.includes(escaped)) {
    return { text: '\\', length: 1, isQuoting: false };
  }

  return { text: escaped === '\n' ? '' : escaped, length: 2, isQuoting: false };
}

const ansiCEscapes = new Map([
  ['a', '\u0007'],
  ['b', '\b'],
  ['e', '\u001B'],
  ['E', '\u001B'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['?', '?'],
]);

const ansiCBytePattern = /^\\(?:(?<octal>[0-7]{1,3})|x(?<hex>[\dA-Fa-f]{1,2}))/u;

const ansiCCodePattern =
  /^\\(?:u(?<unicode>[\dA-Fa-f]{1,4})|U(?<wide>[\dA-Fa-f]{1,8})|c(?<control>[\s\S]))/u;

// Inside `$'...'`, a backslash starts one of the escapes the Bash manual lists, and an unknown one
// keeps its backslash. Bash ends the expansion at a NUL, so the rest of the quote drops out.
function parseANSICEscape(command: string, index: number): ShellEscape {
  const named = ansiCEscapes.get(command.charAt(index + 1));

  const escape =
    named === undefined
      ? parseANSICNumber(command, index)
      : { text: named, length: 2, isQuoting: false };

  const end = escape?.text.indexOf('\0') ?? -1;

  if (escape === undefined) {
    return { text: '\\', length: 1, isQuoting: false };
  }

  return end === -1
    ? escape
    : {
        text: escape.text.slice(0, end),
        length: getANSICQuoteEnd(command, index + escape.length) - index,
        isQuoting: false,
      };
}

// Octal and hexadecimal escapes each give one byte, so a run of them decodes as UTF-8 together.
function parseANSICNumber(command: string, index: number): ShellEscape | undefined {
  const bytes: number[] = [];
  let length = 0;
  let match = ansiCBytePattern.exec(command.slice(index));

  while (match?.groups !== undefined) {
    const octal = match.groups['octal'];

    bytes.push(
      (octal === undefined
        ? Number.parseInt(match.groups['hex'] ?? '', 16)
        : Number.parseInt(octal, 8)) & 0xff,
    );

    length += match[0].length;
    match = ansiCBytePattern.exec(command.slice(index + length));
  }

  if (bytes.length > 0) {
    return { text: new TextDecoder().decode(new Uint8Array(bytes)), length, isQuoting: false };
  }

  const code = ansiCCodePattern.exec(command.slice(index, index + 10));

  return code?.groups === undefined
    ? undefined
    : { text: parseANSICCode(code.groups), length: code[0].length, isQuoting: false };
}

function parseANSICCode(groups: Readonly<Record<string, string | undefined>>): string {
  const control = groups['control'];
  const point = Number.parseInt(groups['unicode'] ?? groups['wide'] ?? '', 16);

  if (control !== undefined) {
    return String.fromCodePoint((control.toUpperCase().codePointAt(0) ?? 0) ^ 64);
  }

  return point <= 0x10_ff_ff ? String.fromCodePoint(point) : '';
}

function getANSICQuoteEnd(command: string, start: number): number {
  let index = start;

  while (index < command.length && command.charAt(index) !== "'") {
    index += command.charAt(index) === '\\' ? 2 : 1;
  }

  return Math.min(index, command.length);
}
