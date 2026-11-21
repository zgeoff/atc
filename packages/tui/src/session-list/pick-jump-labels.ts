const LETTERS = 'asdfghjklqwertyuiopzxcvbnm';

// A label for each name, in order, or null for a name that gets none. The names are the rows that
// still match what the user typed. A label is never a letter that would extend the search. When
// the free letters run out, every label is a free letter and then any letter.
export function pickJumpLabels(names: readonly string[], typed: string): (string | null)[] {
  const needle = typed.toLowerCase();
  const blocked = collectExtendingLetters(names, needle);
  const free = LETTERS.split('').filter((letter) => !blocked.has(letter));

  if (names.length <= free.length) {
    return names.map((_name, index) => free[index] ?? null);
  }

  return names.map((_name, index) => {
    const first = free[Math.floor(index / LETTERS.length)];

    return first === undefined ? null : `${first}${LETTERS[index % LETTERS.length] ?? ''}`;
  });
}

function collectExtendingLetters(names: readonly string[], needle: string): Set<string> {
  const letters = new Set<string>();

  for (const name of names.map((entry) => entry.toLowerCase())) {
    if (needle === '') {
      for (const letter of name) {
        letters.add(letter);
      }

      continue;
    }

    for (let from = name.indexOf(needle); from !== -1; from = name.indexOf(needle, from + 1)) {
      const next = name[from + needle.length];

      if (next !== undefined) {
        letters.add(next);
      }
    }
  }

  return letters;
}
