import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';
import { z } from 'zod';

// A temp git project that holds this repo's hook entries, stub and skill-gate rules, with this
// repo's node_modules, so each entry runs as it runs in a session in a checkout of this repo.
async function setupTest() {
  const temporaryDirectory = setupTempDir('agent-hook-entries-');
  const repoDir = join(import.meta.dir, '..');
  const project = join(temporaryDirectory.path, 'project');
  const transcriptPath = join(temporaryDirectory.path, 'session.jsonl');

  mkdirSync(join(project, '.claude/hooks'), { recursive: true });
  mkdirSync(join(project, 'src'));

  for (const file of ['settings.json', 'skill-gate.json', 'hooks/start.ts']) {
    cpSync(join(repoDir, '.claude', file), join(project, '.claude', file));
  }

  symlinkSync(join(repoDir, '.claude/skills'), join(project, '.claude/skills'));
  symlinkSync(join(repoDir, 'node_modules'), join(project, 'node_modules'));
  writeFileSync(transcriptPath, '');

  await runCommand(['git', 'init', '--quiet'], { cwd: project });

  const settingsText = readFileSync(join(project, '.claude/settings.json'), 'utf8');
  const commandSchema = z.object({ type: z.literal('command'), command: z.string() });

  const entrySchema = z.object({
    matcher: z.string().optional(),
    hooks: z.array(commandSchema),
  });

  const hooksSchema = z.record(z.string(), z.array(entrySchema));
  const settings = z.object({ hooks: hooksSchema }).parse(JSON.parse(settingsText));

  const bashCommands = new Map<string, string>();

  for (const [event, entries] of Object.entries(settings.hooks)) {
    const bashEntries = entries.filter((entry) =>
      new RegExp(`^(?:${entry.matcher ?? '.*'})$`, 'u').test('Bash'),
    );

    const commands = bashEntries.flatMap((entry) => entry.hooks).map((hook) => hook.command);

    // `true` ends the chain, so an event with no entry exits 0, and a hook that exits 2 still ends it.
    bashCommands.set(event, [...commands, 'true'].join(' && '));
  }

  return {
    project,
    transcriptPath,
    bashCommands,
    env: { PATH: process.env['PATH'], CLAUDE_PROJECT_DIR: project },
  };
}

test('it blocks with the code-style skills after a Bash command that changes a gated TypeScript file', async () => {
  const ctx = await setupTest();

  const bashCall = {
    cwd: ctx.project,
    transcript_path: ctx.transcriptPath,
    tool_name: 'Bash',
    tool_input: { command: 'node scripts/write-sample.mjs' },
    tool_use_id: 'toolu_bash_1',
  };

  const beforePayload = JSON.stringify({ ...bashCall, hook_event_name: 'PreToolUse' });
  const afterPayload = JSON.stringify({ ...bashCall, hook_event_name: 'PostToolUse' });
  const changedPath = join(ctx.project, 'src/sample.ts');

  await runCommand(['sh', '-c', ctx.bashCommands.get('PreToolUse') ?? 'true'], {
    env: ctx.env,
    stdin: beforePayload,
  });

  writeFileSync(changedPath, 'export const sample = 1;\n');

  const result = await runCommand(['sh', '-c', ctx.bashCommands.get('PostToolUse') ?? 'true'], {
    env: ctx.env,
    stdin: afterPayload,
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toStrictEqual(
    {
      exitCode: 2,
      stdout: '',
      stderr: `skill-gate: this Bash command changed the gated path ${changedPath} before the session loaded the skills it needs. Load the \`code-style\` and \`project-code-style\` skills with the Skill tool, then review what the command changed against them and fix what breaks a rule. Change a gated path only with Edit, Write or MultiEdit, never through Bash. .claude/skill-gate.json lists the skills each path needs.\n`,
    },
  );
});

test('it asks for the code-style skills after a failed Bash command that changes a gated TypeScript file', async () => {
  const ctx = await setupTest();

  const bashCall = {
    cwd: ctx.project,
    transcript_path: ctx.transcriptPath,
    tool_name: 'Bash',
    tool_input: { command: 'node scripts/write-sample.mjs' },
    tool_use_id: 'toolu_bash_1',
  };

  const beforePayload = JSON.stringify({ ...bashCall, hook_event_name: 'PreToolUse' });

  const afterPayload = JSON.stringify({
    ...bashCall,
    hook_event_name: 'PostToolUseFailure',
    error: 'Exit code 1',
  });

  const changedPath = join(ctx.project, 'src/sample.ts');

  await runCommand(['sh', '-c', ctx.bashCommands.get('PreToolUse') ?? 'true'], {
    env: ctx.env,
    stdin: beforePayload,
  });

  writeFileSync(changedPath, 'export const sample = 1;\n');

  const result = await runCommand(
    ['sh', '-c', ctx.bashCommands.get('PostToolUseFailure') ?? 'true'],
    {
      env: ctx.env,
      stdin: afterPayload,
    },
  );

  const output: unknown = JSON.parse(result.stdout);

  expect({ exitCode: result.exitCode, output }).toStrictEqual({
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: `skill-gate: this Bash command changed the gated path ${changedPath} before the session loaded the skills it needs. Load the \`code-style\` and \`project-code-style\` skills with the Skill tool, then review what the command changed against them and fix what breaks a rule. Change a gated path only with Edit, Write or MultiEdit, never through Bash. .claude/skill-gate.json lists the skills each path needs.`,
      },
    },
  });
});
