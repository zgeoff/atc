import { expect, test } from 'bun:test';
import { normalizeClientName } from './normalize-client-name';

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
  ['a bidi override', 'dots\u202Egnp.exe', 'dotsgnp.exe'],
  ['a zero-width joiner', 'do\u200Dts', 'dots'],
  ['runs of whitespace', '  my   client  ', 'my client'],
  ['an overlong name', 'x'.repeat(150), 'x'.repeat(100)],
  ['only control characters', '\u001B\u0007\u202E', 'unnamed client'],
  ['an empty name', '', 'unnamed client'],
  ['a non-string name', 42, 'unnamed client'],
])('it folds %s to a printable name', (_label, raw, folded) => {
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
