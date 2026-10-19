import { expect, test } from 'bun:test';
import { buildMockAuthProfile } from '@atc/test-utils';
import { collectAuthProfileProblems } from './collect-auth-profile-problems';

test('it finds no problem in profiles whose names impd accepts', () => {
  const notes = buildMockAuthProfile({ name: 'notes', secret: 'notes-key', header: 'x-api-key' });
  const github = buildMockAuthProfile({ kind: 'github', name: 'github', secret: 'github-agents' });

  const problems = collectAuthProfileProblems(
    'box',
    new Map([
      ['notes', notes],
      ['github', github],
    ]),
  );

  expect(problems).toStrictEqual([]);
});

test('it reports a secret name and a header name that impd refuses', () => {
  const notes = buildMockAuthProfile({ name: 'notes', secret: 'Notes_Key', header: 'X-Api-Key' });
  const problems = collectAuthProfileProblems('box', new Map([['notes', notes]]));

  expect(problems).toStrictEqual([
    'target "box" cannot use authProfiles.notes: its secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens, the secret names impd accepts',
    'target "box" cannot use authProfiles.notes: its header must be up to 64 lowercase letters, digits or hyphens, the header names impd accepts',
  ]);
});

test('it reports a github profile whose secret name impd refuses', () => {
  const github = buildMockAuthProfile({ kind: 'github', name: 'github', secret: '1-github' });
  const problems = collectAuthProfileProblems('box', new Map([['github', github]]));

  expect(problems).toStrictEqual([
    'target "box" cannot use authProfiles.github: its secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens, the secret names impd accepts',
  ]);
});
