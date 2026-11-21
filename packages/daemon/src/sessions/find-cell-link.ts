import { isRecord } from '@atc/core';
import type { IBufferCell, Terminal } from '@xterm/headless';

// xterm's public cell API exposes no hyperlink, so the target comes from the cell's extended
// attributes and the terminal's link service.
export function findCellLink(term: Terminal, cell: IBufferCell): string | null {
  const urlID = findMember(findMember(cell, 'extended'), 'urlId');

  if (typeof urlID !== 'number' || urlID === 0) {
    return null;
  }

  const links = findMember(Reflect.get(term, '_core'), '_oscLinkService');
  const getLinkData = findMember(links, 'getLinkData');

  if (typeof getLinkData !== 'function') {
    return null;
  }

  const uri = findMember(Reflect.apply(getLinkData, links, [urlID]), 'uri');

  return typeof uri === 'string' ? uri : null;
}

function findMember(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
