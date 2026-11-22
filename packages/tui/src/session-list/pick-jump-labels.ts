const LETTERS = 'asdfghjklqwertyuiopzxcvbnm';

// A label for each name that matches what the user typed, or null where none is due. Free letters,
// which never extend the search, come first. With more names than free letters, the user keeps
// typing to narrow the rows, and a label grows to two letters only when no letter would split them.
export function pickJumpLabels(names: readonly string[], typed: string): (string | null)[] {
  const needle = typed.toLowerCase();

  if (needle === '') {
    return names.map(() => null);
  }

  const continuations = names.map((name) => collectContinuations(name.toLowerCase(), needle));

  const blocked = new Set(continuations.flatMap((letters) => [...letters]));

  const free = LETTERS.split('').filter((letter) => !blocked.has(letter));

  if (names.length <= free.length) {
    return names.map((_name, index) => free[index] ?? null);
  }

  const canSplit = [...blocked].some((letter) =>
    continuations.some((letters) => !letters.has(letter)),
  );

  if (canSplit) {
    return names.map(() => null);
  }

  const firsts = [...free, ...LETTERS.split('').filter((letter) => blocked.has(letter))];

  return names.map((_name, index) => {
    const first = firsts[Math.floor(index / LETTERS.length)];

    return first === undefined ? null : `${first}${LETTERS[index % LETTERS.length] ?? ''}`;
  });
}

// the letters that follow each occurrence of the needle in the name
function collectContinuations(name: string, needle: string): Set<string> {
  const letters = new Set<string>();

  for (let from = name.indexOf(needle); from !== -1; from = name.indexOf(needle, from + 1)) {
    const next = name[from + needle.length];

    if (next !== undefined) {
      letters.add(next);
    }
  }

  return letters;
}
