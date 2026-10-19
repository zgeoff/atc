import { readFileSync } from 'node:fs';

export function readParentPID(pid: number, procDir = '/proc'): number | null {
  let stat: string;

  try {
    stat = readFileSync(`${procDir}/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }

  // The command name sits in parentheses and may hold spaces or a `)`, so
  // the fields are read after its last `)`: the state, then the parent pid.
  const nameEnd = stat.lastIndexOf(')');

  if (nameEnd === -1) {
    return null;
  }

  const fields = stat.slice(nameEnd + 2).split(' ');
  const parent = Number(fields[1]);

  return Number.isInteger(parent) && parent >= 0 ? parent : null;
}
