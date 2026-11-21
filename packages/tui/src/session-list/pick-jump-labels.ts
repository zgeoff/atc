const LETTERS = 'asdfghjklqwertyuiopzxcvbnm';

// A label for each name that still matches what the user typed, or null past 676 names. Free
// letters, which never extend the search, come first; with too few, every label is a free letter
// and then any letter, and the first letters run on into the letters that would extend the search.
export function pickJumpLabels(names: readonly string[], typed: string): (string | null)[] {
  const needle = typed.toLowerCase();
  const blocked = collectExtendingLetters(names, needle);
  const free = LETTERS.split('').filter((letter) => !blocked.has(letter));

  if (names.length <= free.length) {
    return names.map((_name, index) => free[index] ?? null);
  }

  const firsts = [...free, ...LETTERS.split('').filter((letter) => blocked.has(letter))];

  return names.map((_name, index) => {
    const first = firsts[Math.floor(index / LETTERS.length)];

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
