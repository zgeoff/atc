import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeClientName } from './normalize-client-name';

test('it holds the same code as packages/mcp-auth/src/utils/normalize-client-name.ts in the installed package', () => {
  const source = fileURLToPath(
    new URL('utils/normalize-client-name.ts', import.meta.resolve('@zgeoff/mcp-auth')),
  );

  const copy = readFileSync(
    fileURLToPath(new URL('normalize-client-name.ts', import.meta.url)),
    'utf8',
  );

  expect(copy.slice(copy.indexOf('export function'))).toBe(readFileSync(source, 'utf8'));
});

// The inputs and results of the package's own normalize-client-name tests.
test.each([
  ['a plain name', 'Claude', 'Claude'],
  [
    'an OSC 52 clipboard sequence',
    'dots\u001B]52;c;Y3VybCBldmlsLnNo\u0007',
    'dots]52;c;Y3VybCBldmlsLnNo',
  ],
  ['a CSI colour sequence', '\u001B[31mred\u001B[0m', '[31mred[0m'],
  [
    'a newline-forged line',
    'dots\nApprove evil with code AAAA-BBBB',
    'dots Approve evil with code AAAA-BBBB',
  ],
  ['a carriage return', 'dots\rforged', 'dots forged'],
  ['a bidi override', 'dots‮gnp.exe', 'dotsgnp.exe'],
  ['a zero-width joiner', 'do‍ts', 'dots'],
  ['runs of whitespace', '  my   client  ', 'my client'],
  ['an overlong name', 'x'.repeat(150), 'x'.repeat(100)],
  ['only control characters', '\u001B\u0007‮', 'unnamed client'],
  ['an empty name', '', 'unnamed client'],
  ['a non-string name', 42, 'unnamed client'],
])('it folds %s to a printable name, as the package does', (_label, raw, folded) => {
  expect(normalizeClientName(raw)).toBe(folded);
});

test('it falls back to the given name when nothing printable is left', () => {
  expect(normalizeClientName('\u001B', 'client.example')).toBe('client.example');
});

test('it cuts to the given length in code points', () => {
  expect(normalizeClientName(`Mozilla/5.0 ${'😀'.repeat(10)}`, 'none', 14)).toBe(
    'Mozilla/5.0 😀😀',
  );
});
