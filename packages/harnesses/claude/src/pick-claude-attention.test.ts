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

test('it judges a delivered plugin prompt above a busy spinner as working', () => {
  expect(
    pickClaudeAttention(
      [
        ' ▐▛███▛█   Claude Code v2.1.294',
        '',
        '› Prompt from the atc-bridge plugin',
        '❯ The atc-bridge plugin sent a message:',
        '  <atc-message id="m-41" from="porter">',
        '  Count the gulls on the north pier and report the total.',
        '  </atc-message>',
        '',
        '  This is how Claude Code surfaces a prompt a plugin submits between turns.',
        '  Address the message above.',
        '',
        '✽ Computing… (33s)',
        '',
        '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt',
      ].join('\n'),
    ),
  ).toBe('working');
});

test('it judges a delivered plugin prompt in the detailed transcript view as working', () => {
  expect(
    pickClaudeAttention(
      [
        '❯ say hello',
        '',
        '● Hello.',
        '',
        '› Prompt from the atc-bridge plugin',
        '❯ The atc-bridge plugin sent a message:',
        '  <atc-message id="m-41" from="porter">',
        '  Count the gulls on the north pier and report the total.',
        '  </atc-message>',
        '',
        '  Address the message above.',
        '',
        '────────────────────────────────────────────────────────────',
        '  Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · ? for shortcuts',
      ].join('\n'),
    ),
  ).toBe('working');
});

test('it judges a permission prompt below a delivered plugin prompt as waiting on the owner', () => {
  expect(
    pickClaudeAttention(
      [
        '› Prompt from the atc-bridge plugin',
        '❯ The atc-bridge plugin sent a message:',
        '  <atc-message id="m-41" from="porter">',
        '  Count the gulls on the north pier and report the total.',
        '  </atc-message>',
        '',
        '────────────────────────────────────────────────────────────',
        ' Bash command',
        '',
        '   ls /srv/pier/gulls',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        "   2. Yes, and don't ask again for ls commands in /srv/pier",
        '   3. No',
        '',
        ' Esc to cancel · Tab to amend',
      ].join('\n'),
    ),
  ).toBe('needs-input');
});

test('it judges a screen that has drawn nothing yet as working', () => {
  expect(pickClaudeAttention('')).toBe('working');
});
