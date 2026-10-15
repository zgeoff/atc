import { expect, test } from 'bun:test';
import { findClaudeMenu } from './find-claude-menu';

test('it reads the folder-trust dialog as its text and two plain options', () => {
  const screen = [
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    ' Accessing workspace:',
    '',
    ' /home/dev/projects/lantern',
    '',
    ' Quick safety check: Is this a project you created or one you trust?',
    '',
    ' Security guide',
    '',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');

  expect(findClaudeMenu(screen)).toStrictEqual({
    text: [
      'Accessing workspace:',
      '',
      '/home/dev/projects/lantern',
      '',
      'Quick safety check: Is this a project you created or one you trust?',
      '',
      'Security guide',
    ].join('\n'),
    options: [
      { label: 'No, exit', checked: null },
      { label: 'Yes, I trust this folder', checked: null },
    ],
    highlighted: 0,
  });
});

test('it reads the new MCP servers menu as ticked boxes and the enable item', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    '  3 new MCP servers found in this project',
    '',
    '  Select any you wish to enable.',
    '',
    '    [✔] kettle-notes',
    '  ❯ [ ] orchard-search',
    '    [✔] quarry-files',
    '       Enable selected',
    '',
    ' Space to select · Esc to reject all',
  ].join('\n');

  expect(findClaudeMenu(screen)).toStrictEqual({
    text: '3 new MCP servers found in this project\n\nSelect any you wish to enable.',
    options: [
      { label: 'kettle-notes', checked: true },
      { label: 'orchard-search', checked: false },
      { label: 'quarry-files', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 1,
  });
});

test('it reads the cursor on the enable item of a box menu', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    '  2 new MCP servers found in this project',
    '',
    '    [✔] kettle-notes',
    '    [✔] quarry-files',
    '  ❯    Enable selected',
  ].join('\n');

  expect(findClaudeMenu(screen)?.highlighted).toBe(2);
});

test('it reads the rows of a scrolled list and its mark of options below', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    '  8 new MCP servers found in this project',
    '  Select any you wish to enable.',
    '',
    '  MCP servers may execute code or access system resources.',
    '',
    '  ❯ [✔] kettle-notes',
    '    [✔] orchard-search',
    '    [✔] quarry-files',
    '    [✔] lantern-docs',
    '  ↓ [✔] meadow-index',
    '       Enable selected',
    '',
    ' Space to select · Esc to reject all',
  ].join('\n');

  expect(findClaudeMenu(screen)).toStrictEqual({
    text: [
      '8 new MCP servers found in this project',
      'Select any you wish to enable.',
      '',
      'MCP servers may execute code or access system resources.',
    ].join('\n'),
    options: [
      { label: 'kettle-notes', checked: true },
      { label: 'orchard-search', checked: true },
      { label: 'quarry-files', checked: true },
      { label: 'lantern-docs', checked: true },
      { label: 'meadow-index', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 0,
    scroll: { above: false, below: true },
  });
});

test('it reads a full window with the cursor on its last row as a list that may scroll', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    '  7 new MCP servers found in this project',
    '',
    '    [✔] kettle-notes',
    '    [✔] orchard-search',
    '    [✔] quarry-files',
    '    [✔] lantern-docs',
    '  ❯ [✔] meadow-index',
    '       Enable selected',
    ...Array.from({ length: 15 }, () => ''),
  ].join('\n');

  expect(findClaudeMenu(screen)?.scroll).toStrictEqual({ above: false, below: false });
});

test('it reads a full window with the cursor above its last row as the whole list', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    '  5 new MCP servers found in this project',
    '',
    '    [✔] kettle-notes',
    '    [✔] orchard-search',
    '    [✔] quarry-files',
    '  ❯ [✔] lantern-docs',
    '    [✔] meadow-index',
    '       Enable selected',
    ...Array.from({ length: 15 }, () => ''),
  ].join('\n');

  expect(findClaudeMenu(screen)).not.toContainKey('scroll');
});

test('it reads both scroll marks of a list scrolled to its middle', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    '  8 new MCP servers found in this project',
    '',
    '  ↑ [✔] orchard-search',
    '    [✔] quarry-files',
    '  ❯ [ ] lantern-docs',
    '    [✔] meadow-index',
    '  ↓ [✔] willow-cache',
    '       Enable selected',
  ].join('\n');

  expect(findClaudeMenu(screen)).toMatchObject({
    options: [
      { label: 'orchard-search', checked: true },
      { label: 'quarry-files', checked: true },
      { label: 'lantern-docs', checked: false },
      { label: 'meadow-index', checked: true },
      { label: 'willow-cache', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 2,
    scroll: { above: true, below: true },
  });
});

test('it reads a numbered permission prompt and joins a wrapped option', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    ' Bash command',
    '',
    '   git push origin lantern-fix',
    '   Push the fix branch',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for git push commands in",
    '      /home/dev/projects/lantern',
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');

  expect(findClaudeMenu(screen)).toStrictEqual({
    text: [
      'Bash command',
      '',
      '  git push origin lantern-fix',
      '  Push the fix branch',
      '',
      'Do you want to proceed?',
    ].join('\n'),
    options: [
      { label: 'Yes', checked: null },
      {
        label: "Yes, and don't ask again for git push commands in /home/dev/projects/lantern",
        checked: null,
      },
      { label: 'No', checked: null },
    ],
    highlighted: 0,
  });
});

test('it drops the mark of the value already in effect from a plain option', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    ' Choose the text style that looks best with your terminal',
    '',
    '     Auto (match terminal)',
    '   ✔ Dark mode',
    ' ❯   Light mode',
  ].join('\n');

  expect(findClaudeMenu(screen)?.options).toStrictEqual([
    { label: 'Auto (match terminal)', checked: null },
    { label: 'Dark mode', checked: null },
    { label: 'Light mode', checked: null },
  ]);
});

test('it finds no menu in the prompt box when a line is typed into it', () => {
  const screen = [
    ' Claude Code v2.1.294',
    '',
    '──────────────────────────────────────────────────────────────────────────────',
    '❯ rename the lantern module',
    '  and update its tests',
    '──────────────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');

  expect(findClaudeMenu(screen)).toBeNull();
});

test('it finds no menu in the prompt box when the typed draft holds a blank line', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    '❯ rename the lantern module',
    '  and update its tests',
    '',
    '  then run the suite',
    '──────────────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');

  expect(findClaudeMenu(screen)).toBeNull();
});

test('it finds no menu above an empty prompt box', () => {
  const screen = [
    '❯ rename the lantern module',
    '  and update its tests',
    '',
    '● Renamed the module.',
    '',
    '──────────────────────────────────────────────────────────────────────────────',
    '❯',
    '──────────────────────────────────────────────────────────────────────────────',
  ].join('\n');

  expect(findClaudeMenu(screen)).toBeNull();
});

test('it finds no menu with a single option', () => {
  const screen = [
    '──────────────────────────────────────────────────────────────────────────────',
    ' Press Enter to continue',
    '',
    ' ❯ Continue',
  ].join('\n');

  expect(findClaudeMenu(screen)).toBeNull();
});

test('it takes the text from the top of the screen when no border sits above the menu', () => {
  const screen = [' Pick a colour', '', ' ❯ Amber', '   Teal'].join('\n');

  expect(findClaudeMenu(screen)?.text).toBe('Pick a colour');
});
