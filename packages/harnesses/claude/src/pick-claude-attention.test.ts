import { expect, test } from 'bun:test';
import { pickClaudeAttention } from './pick-claude-attention';

test('it judges the folder-trust dialog as waiting on the owner', () => {
  expect(
    pickClaudeAttention(
      [
        '────────────────────────────────────────────────────────────',
        ' Accessing workspace:',
        '',
        ' /srv/orchard/checkout',
        '',
        ' Quick safety check: Is this a project you created or one you trust?',
        '',
        " Claude Code'll be able to read, edit, and execute files here.",
        '',
        ' ❯ No, exit',
        '   Yes, I trust this folder',
        '',
        ' Enter to confirm · Esc to cancel',
      ].join('\n'),
    ),
  ).toBe('needs-input');
});

test('it judges an empty prompt box as working', () => {
  expect(
    pickClaudeAttention(
      [
        ' ✻ Welcome to Claude Code!',
        '',
        '────────────────────────────────────────────────────────────',
        '❯ ',
        '────────────────────────────────────────────────────────────',
        '  ? for shortcuts',
      ].join('\n'),
    ),
  ).toBe('working');
});

test('it judges a screen that has drawn nothing yet as working', () => {
  expect(pickClaudeAttention('')).toBe('working');
});
