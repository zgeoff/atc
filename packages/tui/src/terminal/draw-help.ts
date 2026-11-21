import { cols } from './cols';
import { boxBottom, boxDivider, boxRow, boxTop, dimRow, drawBox } from './draw-box';
import type { Row } from './types';
import { writeOut } from './write-out';

export function drawHelp() {
  const width = Math.min(cols() - 4, 60);

  const lines = [
    '⏎  attach the selected session',
    '⇥  attach the most urgent needs-you, else latest done',
    'f  jump: a letter on each row, then that letter attaches it',
    'i  go home, and let the session behind the list go',
    'H  eject to a headless run (Claude only)',
    'P  revive a dead or headless session',
    'y  yank the resume command to the clipboard',
    'Y  yank the resume command, then kill here',
    'K  kill a live session and keep it in the list',
    'X  end: stop the agent and remove the session',
    'p  pin or unpin — pinned sessions stay on top',
    '    a sub-session pins with its parent unless pinned itself',
    'g  group by repository, then by place, then flat',
    'n  new session',
    'r  adopt an external session',
    '/  filter · ↑↓/jk move · q quit',
  ];

  const rowsList: Row[] = [boxTop(width, 'keys')];

  for (const line of lines) {
    rowsList.push(boxRow(width, line, line.length));
  }

  rowsList.push(boxDivider(width), dimRow(width, 'esc/? back'), boxBottom(width));

  drawBox(rowsList, writeOut);
}
