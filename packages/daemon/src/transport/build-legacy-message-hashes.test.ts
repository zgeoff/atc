import { expect, test } from 'bun:test';
import { buildLegacyMessageHashes } from './build-legacy-message-hashes';
import { buildPayloadHash } from './build-payload-hash';

const PARAMS = { session: 's1', text: 'check the tide tables', idempotencyKey: 'k-1' };

test('it hashes the payload with the from the request gives and each name given', () => {
  expect(buildLegacyMessageHashes(PARAMS, 'release-bot', ['mcp', 'Lantern Notes'])).toStrictEqual([
    buildPayloadHash({ session: 's1', text: 'check the tide tables', from: 'release-bot' }),
    buildPayloadHash({ session: 's1', text: 'check the tide tables', from: 'mcp' }),
    buildPayloadHash({ session: 's1', text: 'check the tide tables', from: 'Lantern Notes' }),
  ]);
});

test('it hashes the payload with the default from when the request gives none', () => {
  expect(buildLegacyMessageHashes(PARAMS, undefined, [])).toStrictEqual([
    buildPayloadHash({ session: 's1', text: 'check the tide tables', from: 'unknown' }),
  ]);
});

test('it hashes each from once and skips an empty or missing name', () => {
  expect(buildLegacyMessageHashes(PARAMS, '', ['unknown', '', null, undefined])).toStrictEqual([
    buildPayloadHash({ session: 's1', text: 'check the tide tables', from: 'unknown' }),
  ]);
});
