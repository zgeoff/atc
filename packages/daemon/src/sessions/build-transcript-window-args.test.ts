import { expect, test } from 'bun:test';
import { buildTranscriptWindowArgs } from './build-transcript-window-args';

test.each([
  ['the start of the file', 0, 10, ['0', '1']],
  ['a whole block', 65_536, 65_536, ['1', '1']],
  ['a window across a block boundary', 65_530, 10, ['0', '2']],
])('it asks for the whole blocks that hold %s', (_label, offset, length, blocks) => {
  expect(
    buildTranscriptWindowArgs('/tmp/atc/sessions/s-1/a-1.jsonl', offset, length),
  ).toStrictEqual(['/tmp/atc/sessions/s-1/a-1.jsonl', ...blocks]);
});
