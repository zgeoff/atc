import { ansi } from '@atc/core';
import type { SessionViewState } from '@atc/protocol';
import { cols } from './cols';
import { rows } from './rows';
import { truncate } from './truncate';
import { writeOut } from './write-out';

const ESC = '\u001B';

export interface StatusView {
  readonly counts: Readonly<Record<SessionViewState, number>>;
  readonly focusedName: string | null;
  readonly urgentName: string | null;
  readonly leaderLabel: string;
  readonly stale: boolean;
  readonly restarting: boolean;
  readonly waiting?: boolean;

  readonly daemonName?: string | null;

  readonly notice?: string | null;
}

export function eraseStatusBar() {
  writeOut(`${ansi.saveCursor}${ansi.moveTo(rows(), 1)}${ESC}[0m${ESC}[2K${ansi.restoreCursor}`);
}

export function drawStatusBar(view: StatusView) {
  const counts = view.counts;
  const width = cols();

  const where =
    view.daemonName === undefined || view.daemonName === null ? '' : `@${view.daemonName}`;

  const left = ` atc${where} ▏${view.focusedName ?? 'no session'} `;
  const parts: string[] = [];

  if (counts.needs_you > 0) {
    const who = view.urgentName === null ? '' : `: ${view.urgentName}`;

    parts.push(`● ${counts.needs_you} need you${who}`);
  }

  if (counts.done > 0) {
    parts.push(`✓ ${counts.done} done`);
  }

  if (counts.running > 0) {
    parts.push(`◐ ${counts.running} running`);
  }

  if (counts.unknown > 0) {
    parts.push(`? ${counts.unknown} unknown`);
  }

  if (counts.exited > 0) {
    parts.push(`✗ ${counts.exited}`);
  }

  if (view.notice !== undefined && view.notice !== null) {
    parts.push(view.notice);
  }

  if (view.waiting === true) {
    parts.push('⟳ waiting for daemon');
  } else if (view.restarting) {
    parts.push('⟳ restarting daemon');
  } else if (view.stale) {
    parts.push('⟳ update ready');
  }

  const joined = parts.join(' ▏');
  const right = ` ${joined === '' ? 'idle' : joined} ▏${view.leaderLabel} `;
  const pad = Math.max(1, width - left.length - right.length);
  const bg = counts.needs_you > 0 ? `${ESC}[1;97;41m` : `${ESC}[30;47m`;
  const text = truncate(left + ' '.repeat(pad) + right, width).padEnd(width);

  writeOut(ansi.saveCursor + ansi.moveTo(rows(), 1) + bg + text + ansi.reset + ansi.restoreCursor);
}
