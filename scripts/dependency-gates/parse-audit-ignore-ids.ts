import { parseShellWords } from '../parse-shell-words.ts';

export function parseAuditIgnoreIDs(auditScript: string): string[] {
  const words = parseShellWords(auditScript).map((word) => word.text);

  return words.flatMap((word, index) => {
    if (word.startsWith('--ignore=')) {
      return [word.slice('--ignore='.length)];
    }

    const next = words[index + 1];

    return word === '--ignore' && next !== undefined ? [next] : [];
  });
}
