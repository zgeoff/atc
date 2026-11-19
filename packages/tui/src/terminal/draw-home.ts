import { ansi } from '@atc/core';
import { cols } from './cols';
import { rows } from './rows';
import { writeOut } from './write-out';

const ESC = '\u001B';

export function drawHome(fleetCount = 0, leaderLabel = '^Space') {
  writeOut(ansi.clear + ansi.hideCursor);

  const msgs = [
    'atc — control tower for coding-agent sessions',
    '',
    'n       spawn a session',
    'r       adopt an existing session',
    ...(fleetCount > 0 ? [`R       restore last fleet (${fleetCount} sessions)`] : []),
    `${leaderLabel.padEnd(7)} session list`,
    'q       quit',
  ];

  const top = Math.max(1, Math.floor((rows() - 1 - msgs.length) / 2));

  for (const [index, line] of msgs.entries()) {
    const left = Math.max(1, Math.floor((cols() - line.length) / 2));
    const styled = index === 0 ? `${ESC}[1m${line}${ESC}[0m` : `${ESC}[90m${line}${ESC}[0m`;

    writeOut(ansi.moveTo(top + index, left) + styled);
  }
}
