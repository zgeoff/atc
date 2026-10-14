import { expect, test } from 'bun:test';
import { renderNoticeLine } from './render-notice-line';

test('it renders an answered notice as one answer line with no text field', () => {
  const line = renderNoticeLine({
    message: 'm-1',
    from: 's-2',
    status: 'answered',
    answer: 'the migration ran',
  });

  expect(line).toBe(
    '{"kind":"answer","id":"m-1","from":"s-2","status":"answered","answer":"the migration ran"}\n',
  );
});

test('it renders an unanswered notice with its reason', () => {
  const line = renderNoticeLine({
    message: 'm-1',
    from: 's-2',
    status: 'unanswered',
    reason: 'session_ended',
  });

  expect(line).toBe(
    '{"kind":"answer","id":"m-1","from":"s-2","status":"unanswered","reason":"session_ended"}\n',
  );
});
