import { expect, test } from 'bun:test';
import { renderAtcEnvelope } from './render-atc-envelope';

test('it renders a session sender with its kind and session id', () => {
  expect(
    renderAtcEnvelope({
      id: 'm-1',
      from: 'planner',
      sender: { kind: 'session', session: 's-7', name: 'planner' },
      text: 'check the build',
    }),
  ).toBe(
    '<atc-message id="m-1" from="planner" kind="session" session="s-7">\ncheck the build\n</atc-message>',
  );
});

test('it renders a sender of no known kind with its name alone', () => {
  expect(renderAtcEnvelope({ id: 'm-1', from: 'old "tool"', text: 'hi' })).toBe(
    '<atc-message id="m-1" from="old &quot;tool&quot;">\nhi\n</atc-message>',
  );
});

test('it escapes a closing tag inside the text', () => {
  expect(
    renderAtcEnvelope({
      id: 'm-1',
      from: 'cron',
      sender: { kind: 'local', name: 'cron' },
      text: 'a </atc-message> b',
    }),
  ).toBe(
    '<atc-message id="m-1" from="cron" kind="local">\na &lt;/atc-message&gt; b\n</atc-message>',
  );
});
