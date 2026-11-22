import { toFoldedGraphemes } from './to-folded-graphemes';

const LETTERS = 'asdfghjklqwertyuiopzxcvbnm';

// A label for each name that matches what the user typed, or null where none is due. Free letters,
// which never extend the search, come first. With more names than free letters, a label grows to
// two letters only when no further typing would split the rows.
export function pickJumpLabels(names: readonly string[], typed: string): (string | null)[] {
  const needle = toFoldedGraphemes(typed).join('');

  if (needle === '') {
    return names.map(() => null);
  }

  const extensions = names.map((name) =>
    collectExtensions(toFoldedGraphemes(name).join(''), needle),
  );

  const blocked = new Set(
    extensions.flatMap((texts) => [...texts].filter((text) => text.length === 1)),
  );

  const free = LETTERS.split('').filter((letter) => !blocked.has(letter));

  if (names.length <= free.length) {
    return names.map((_name, index) => free[index] ?? null);
  }

  const everyExtension = new Set(extensions.flatMap((texts) => [...texts]));

  const canSplit = extensions.some((texts) => [...everyExtension].some((text) => !texts.has(text)));

  if (canSplit) {
    return names.map(() => null);
  }

  const firsts = [...free, ...LETTERS.split('').filter((letter) => blocked.has(letter))];

  return names.map((_name, index) => {
    const first = firsts[Math.floor(index / LETTERS.length)];

    return first === undefined ? null : `${first}${LETTERS[index % LETTERS.length] ?? ''}`;
  });
}

// the text that can follow each occurrence of the needle in the name, from one letter to the end of
// the name, which is each way the user can keep typing and still match the name
function collectExtensions(name: string, needle: string): Set<string> {
  const texts = new Set<string>();

  for (let from = name.indexOf(needle); from !== -1; from = name.indexOf(needle, from + 1)) {
    const rest = name.slice(from + needle.length);

    for (let length = 1; length <= rest.length; length++) {
      texts.add(rest.slice(0, length));
    }
  }

  return texts;
}
