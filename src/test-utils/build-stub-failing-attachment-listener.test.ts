import { expect, test } from 'bun:test';
import { buildStubFailingAttachmentListener } from './build-stub-failing-attachment-listener';

test('it throws the given message when a connection is attached', () => {
  const listener = buildStubFailingAttachmentListener('write EPIPE');

  expect(() => {
    listener('attached');
  }).toThrowWithMessage(Error, 'write EPIPE');
});

test('it returns quietly while a connection is reattaching', () => {
  const listener = buildStubFailingAttachmentListener('write EPIPE');

  expect(() => {
    listener('reattaching');
  }).not.toThrow();
});
