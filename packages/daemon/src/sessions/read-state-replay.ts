import { ansi, formatInputModes } from '@atc/core';
import type { InputModes, KittyStacks } from '@atc/core';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { IBuffer, Terminal } from '@xterm/headless';
import { readEmulatorInternals } from './read-emulator-internals';
import type { BufferInternals, CursorShape, EmulatorInternals } from './read-emulator-internals';
import { renderPen } from './render-pen';
import { serializeLinkRuns } from './serialize-link-runs';

export interface StateReplaySource {
  readonly term: Terminal;
  readonly serializer: SerializeAddon;
  readonly inputModes: InputModes;
  readonly kittyStacks: KittyStacks;
}

const RIS = '\u001Bc';
const SERIALIZED_ALT_SWITCH = `${ansi.altScreenOn}${ansi.cursorHome}`;

// A client that resets its emulator and writes this gets the visible rows of both buffers and the
// state xterm keeps beside them. The scrollback stays behind, so a replay stays near two screens.
export function readStateReplay(source: StateReplaySource): string {
  const term = source.term;
  const internals = readEmulatorInternals(term);
  const serialized = source.serializer.serialize({ excludeModes: true, scrollback: 0 });
  const switchAt = serialized.lastIndexOf(SERIALIZED_ALT_SWITCH);
  const isAlternateActive = switchAt !== -1;
  const normalText = isAlternateActive ? serialized.slice(0, switchAt) : serialized;
  let out = `${RIS}${renderKittyStacks(source.kittyStacks)}${normalText}`;

  out += renderBuffer(term, term.buffer.normal, internals.normal, {
    isOriginMode: term.modes.originMode && !isAlternateActive,
  });

  // 1049 would run a DECSC on the normal buffer and overwrite its saved cursor; 1047 switches alone
  if (isAlternateActive) {
    out += `\u001B[?1047h${ansi.cursorHome}`;
    out += serialized.slice(switchAt + SERIALIZED_ALT_SWITCH.length);

    out += renderBuffer(term, term.buffer.alternate, internals.alternate, {
      isOriginMode: term.modes.originMode,
    });
  }

  const active = isAlternateActive ? internals.alternate : internals.normal;

  out += renderPendingWrap(term, term.buffer.active, active);
  out += renderCharsets(internals);
  out += internals.pen === null ? '' : renderPen(internals.pen);
  out += formatInputModes({ ...source.inputModes, kittyStack: [] });
  out += renderTerminalModes(term);
  out += renderCursorShape(internals.cursorShape);

  return `${out}${internals.isCursorHidden ? ansi.hideCursor : ''}`;
}

// The client keeps one kitty stack per screen and swaps them on 47, as on 1047 and 1049.
function renderKittyStacks(stacks: KittyStacks): string {
  const main = stacks.main.map((flags) => `\u001B[>${flags}u`).join('');

  if (stacks.alternate.length === 0) {
    return main;
  }

  const alternate = stacks.alternate.map((flags) => `\u001B[>${flags}u`).join('');

  return `\u001B[?47h${alternate}\u001B[?47l${main}`;
}

interface PlacementOptions {
  readonly isOriginMode: boolean;
}

function renderBuffer(
  term: Terminal,
  buffer: IBuffer,
  internals: BufferInternals,
  options: PlacementOptions,
): string {
  return [
    serializeLinkRuns(term, buffer),
    renderTabStops(term.cols, internals.tabStops),
    renderSavedCursor(internals),
    renderPlacement(buffer, internals, options),
  ].join('');
}

const TAB_WIDTH = 8;

function renderTabStops(cols: number, stops: readonly number[]): string {
  const isDefault =
    stops.length === Math.ceil(cols / TAB_WIDTH) &&
    stops.every((col, index) => col === index * TAB_WIDTH);

  if (isDefault) {
    return '';
  }

  return `\u001B[3g${stops.map((col) => `\u001B[1;${col + 1}H\u001BH`).join('')}`;
}

function renderSavedCursor(internals: BufferInternals): string {
  if (internals.savedPen === null) {
    return '';
  }

  const position = `\u001B[${internals.savedRow + 1};${internals.savedX + 1}H`;

  return `${position}${renderPen(internals.savedPen)}\u001B7\u001B[0m`;
}

// DECSTBM and DECOM each home the cursor, so the cursor goes last. In origin mode its row counts
// from the top of the scroll region.
function renderPlacement(
  buffer: IBuffer,
  internals: BufferInternals,
  options: PlacementOptions,
): string {
  const region = internals.region;
  const top = options.isOriginMode ? (region?.top ?? 0) : 0;
  const row = Math.max(0, buffer.cursorY - top) + 1;
  const regionSequence = region === null ? '' : `\u001B[${region.top + 1};${region.bottom + 1}r`;
  const originSequence = options.isOriginMode ? '\u001B[?6h' : '';

  return `${regionSequence}${originSequence}\u001B[${row};${buffer.cursorX + 1}H`;
}

// A move to the last column leaves no wrap pending; printing the last cell again does.
function renderPendingWrap(term: Terminal, buffer: IBuffer, internals: BufferInternals): string {
  if (internals.cursorX < term.cols) {
    return '';
  }

  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  const last = line?.getCell(term.cols - 1);
  const isWideEnd = last?.getWidth() === 0;
  const cell = isWideEnd ? line?.getCell(term.cols - 2) : last;

  if (cell === undefined) {
    return '';
  }

  const col = isWideEnd ? term.cols - 1 : term.cols;
  const chars = cell.getChars() === '' ? ' ' : cell.getChars();

  return `\u001B[${col}G${renderPen(cell)}${chars}\u001B[0m`;
}

const DESIGNATORS = ['(', ')', '*', '+'] as const;
const SHIFTS = ['', '\u000E', '\u001Bn', '\u001Bo'] as const;

function renderCharsets(internals: EmulatorInternals): string {
  const designations = internals.lineDrawingSlots
    .map((slot) => `\u001B${DESIGNATORS[slot] ?? '('}0`)
    .join('');

  return `${designations}${SHIFTS[internals.charsetLevel] ?? ''}`;
}

function renderTerminalModes(term: Terminal): string {
  const modes = term.modes;

  return [
    modes.wraparoundMode ? '' : '\u001B[?7l',
    modes.insertMode ? '\u001B[4h' : '',
    modes.reverseWraparoundMode ? '\u001B[?45h' : '',
  ].join('');
}

const CURSOR_SHAPE_CODES = { block: 1, underline: 3, bar: 5 } as const;

// DECSCUSR takes the odd code for a blinking cursor and the next even one for a steady cursor.
function renderCursorShape(shape: CursorShape | null): string {
  if (shape === null) {
    return '';
  }

  return `\u001B[${CURSOR_SHAPE_CODES[shape.style] + (shape.isBlinking ? 0 : 1)} q`;
}
