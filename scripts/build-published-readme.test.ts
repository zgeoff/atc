import { expect, test } from 'bun:test';
import { buildPublishedReadme } from './build-published-readme';

test('it points a relative link at the file in the repository at the release', () => {
  expect(
    buildPublishedReadme(
      'The [configuration guide](../../docs/guides/configuration.md) describes each key.\n',
      'https://github.com/zgeoff/atc/blob/%40zgeoff%2Fatc%407.3.0',
      'packages/contract',
    ),
  ).toBe(
    'The [configuration guide](https://github.com/zgeoff/atc/blob/%40zgeoff%2Fatc%407.3.0/docs/guides/configuration.md) describes each key.\n',
  );
});

test('it keeps a link to the section of a file', () => {
  expect(
    buildPublishedReadme(
      '[versions](../../docs/architecture/protocol/protocol.md#versions)\n',
      'https://github.com/zgeoff/atc/blob/main',
      'packages/contract',
    ),
  ).toBe(
    '[versions](https://github.com/zgeoff/atc/blob/main/docs/architecture/protocol/protocol.md#versions)\n',
  );
});

test.each([
  ['a web link', '[npm](https://www.npmjs.com/package/@atcx/contract)\n'],
  ['a mail link', '[mail](mailto:atc@example.com)\n'],
  ['an anchor in the README', '[usage](#usage)\n'],
  ['a link out of the repository', '[outside](../../../elsewhere.md)\n'],
])('it leaves %s as it is', (_label, markdown) => {
  expect(
    buildPublishedReadme(markdown, 'https://github.com/zgeoff/atc/blob/main', 'packages/contract'),
  ).toBe(markdown);
});
