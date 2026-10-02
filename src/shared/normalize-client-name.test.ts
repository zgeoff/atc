import { expect, test } from 'bun:test';
import { normalizeClientName } from './normalize-client-name';

const BIDI_OVERRIDE = String.fromCodePoint(0x20_2e);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x20_0d);

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
  ['a bidi override', `dots${BIDI_OVERRIDE}gnp.exe`, 'dotsgnp.exe'],
  ['a zero-width joiner', `do${ZERO_WIDTH_JOINER}ts`, 'dots'],
  ['runs of whitespace', '  my   client  ', 'my client'],
  ['an overlong name', 'x'.repeat(150), 'x'.repeat(100)],
  ['only control characters', `\u001B\u0007${BIDI_OVERRIDE}`, 'unnamed client'],
  ['an empty name', '', 'unnamed client'],
  ['a non-string name', 42, 'unnamed client'],
])('it folds %s to a printable name', (_label, raw, folded) => {
  expect(normalizeClientName(raw)).toBe(folded);
});

test('it falls back to the given name when nothing printable is left', () => {
  expect(normalizeClientName('\u001B', 'client.example')).toBe('client.example');
});
