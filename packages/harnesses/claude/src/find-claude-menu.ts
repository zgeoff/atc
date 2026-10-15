import type { ScreenMenu, ScreenMenuOption, ScreenMenuScroll } from '@atc/plugin-api';

const POINTER = '❯ ';

// The marks a list that shows only part of its options draws in the
// cursor's column, beside its first row and its last.
const MORE_ABOVE = '↑ ';
const MORE_BELOW = '↓ ';

// A dialog's top border, or the rule above and below the prompt box.
const RULE = /^\s*[─━═╌]{8,}\s*$/;
const NUMBERED = /^\d+\.\s+(?<label>.*)$/;
const BOX = /^\[(?<box>.)\]\s+(?<label>.*)$/;

// The mark a picker puts beside the value already in effect.
const CURRENT_MARK = /^✔\s+/;

// The most lines above the options a menu's text takes, so a screen with no
// border above the menu never makes the text the whole screen.
const MAX_TEXT_LINES = 24;

/**
 * Reads the menu Claude Code waits on from its screen as plain text, or null
 * when it shows none. A menu is the last line on the screen that holds the
 * `❯` cursor, with text after it and the lines beside it indented to the same column: numbered
 * options (`1. Yes`), whose wrapped lines join the option above them, boxes
 * (`[✔] name`) with a plain item such as `Enable selected` among them, or
 * plain options, one per line. A list longer than its window marks its first
 * row with `↑` and its last with `↓` in the cursor's column. Its text is the
 * lines above the options up to the dialog's border. The prompt box, whose `❯` line sits straight under a
 * rule with the draft's lines down to the next rule, is no menu, and neither
 * is a single option.
 */
export function findClaudeMenu(screen: string): ScreenMenu | null {
  const lines = screen.split('\n');
  const at = lines.findLastIndex((line) => hasPointer(line));

  // The last cursor on the screen is the one the agent waits on; an empty
  // prompt box below a menu-like line of the conversation is no menu.
  if (at === -1 || !isPointerLine(lines[at] ?? '')) {
    return null;
  }

  const column = lines[at]?.indexOf(POINTER) ?? 0;
  let first = at;

  while (first > 0 && isOptionLine(lines[first - 1], column)) {
    first--;
  }

  let last = at;

  while (last < lines.length - 1 && isOptionLine(lines[last + 1], column)) {
    last++;
  }

  if ((isRule(lines[first - 1]) && isRule(lines[last + 1])) || isPromptBox(lines, at)) {
    return null;
  }

  const rows = lines.slice(first, last + 1).map((line) => line.slice(column + POINTER.length));
  const parsed = parseOptions(rows, at - first);

  if (parsed === null || parsed.options.length < 2) {
    return null;
  }

  const scroll = findScroll(lines.slice(first, last + 1), column);

  return {
    text: collectText(lines, first),
    options: parsed.options,
    highlighted: parsed.highlighted,
    ...(scroll === null ? {} : { scroll }),
  };
}

function hasPointer(line: string): boolean {
  const at = line.indexOf(POINTER.trimEnd());

  return at !== -1 && line.slice(0, at).trim() === '';
}

function isPointerLine(line: string): boolean {
  const at = line.indexOf(POINTER);

  return (
    at !== -1 && line.slice(0, at).trim() === '' && line.slice(at + POINTER.length).trim() !== ''
  );
}

// A line beside the cursor's: blank up to the cursor's column, two blank
// columns or a scroll mark where the cursor would be, then text.
function isOptionLine(line: string | undefined, column: number): boolean {
  if (line === undefined || line.slice(0, column).trim() !== '') {
    return false;
  }

  const mark = line.slice(column, column + POINTER.length);

  return (
    (mark.trim() === '' || mark === MORE_ABOVE || mark === MORE_BELOW) &&
    line.slice(column + POINTER.length).trim() !== ''
  );
}

// The prompt box: a cursor line straight under a rule, then indented or
// blank lines down to the next rule, as a draft with blank lines in it
// shows.
function isPromptBox(lines: readonly string[], at: number): boolean {
  if (!isRule(lines[at - 1])) {
    return false;
  }

  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';

    if (isRule(line)) {
      return true;
    }

    if (line !== '' && !line.startsWith(' ')) {
      return false;
    }
  }

  return false;
}

function isRule(line: string | undefined): boolean {
  return line !== undefined && RULE.test(line);
}

interface ParsedOptions {
  readonly options: readonly ScreenMenuOption[];
  readonly highlighted: number;
}

function parseOptions(rows: readonly string[], pointerRow: number): ParsedOptions | null {
  const pointed = rows[pointerRow]?.trimStart() ?? '';

  if (NUMBERED.test(pointed)) {
    return parseNumberedOptions(rows, pointerRow);
  }

  const boxed = rows.some((row) => BOX.test(row.trimStart()));

  return {
    options: rows.map((row) => (boxed ? parseBoxOption(row) : parsePlainOption(row))),
    highlighted: pointerRow,
  };
}

// Each numbered row starts an option, and a row without a number continues
// the option above it. Rows above the first number belong to no option.
function parseNumberedOptions(rows: readonly string[], pointerRow: number): ParsedOptions | null {
  const labels: string[] = [];
  let highlighted = -1;

  for (const [index, row] of rows.entries()) {
    const numbered = NUMBERED.exec(row.trimStart());

    if (numbered !== null) {
      labels.push((numbered.groups?.['label'] ?? '').trim());
    } else if (labels.length > 0) {
      labels[labels.length - 1] = `${labels.at(-1) ?? ''} ${row.trim()}`;
    }

    if (index === pointerRow) {
      highlighted = labels.length - 1;
    }
  }

  if (highlighted === -1) {
    return null;
  }

  return { options: labels.map((label) => ({ label, checked: null })), highlighted };
}

function parseBoxOption(row: string): ScreenMenuOption {
  const boxed = BOX.exec(row.trimStart());

  if (boxed === null) {
    return { label: row.trim(), checked: null };
  }

  return { label: (boxed.groups?.['label'] ?? '').trim(), checked: boxed.groups?.['box'] !== ' ' };
}

function parsePlainOption(row: string): ScreenMenuOption {
  return { label: row.trim().replace(CURRENT_MARK, ''), checked: null };
}

// Which scroll marks the option rows hold, or null when they hold none.
function findScroll(rows: readonly string[], column: number): ScreenMenuScroll | null {
  const marks = new Set(rows.map((row) => row.slice(column, column + POINTER.length)));

  const above = marks.has(MORE_ABOVE);
  const below = marks.has(MORE_BELOW);

  return above || below ? { above, below } : null;
}

// The lines above the options up to the nearest rule, without the blank
// lines at either end and without their common indent.
function collectText(lines: readonly string[], first: number): string {
  const above: string[] = [];

  for (let index = first - 1; index >= 0 && above.length < MAX_TEXT_LINES; index--) {
    const line = lines[index] ?? '';

    if (isRule(line)) {
      break;
    }

    above.unshift(line.trimEnd());
  }

  while (above[0] === '') {
    above.shift();
  }

  while (above.at(-1) === '') {
    above.pop();
  }

  const indent = Math.min(
    ...above.filter((line) => line !== '').map((line) => line.length - line.trimStart().length),
  );

  return above.map((line) => line.slice(indent)).join('\n');
}
