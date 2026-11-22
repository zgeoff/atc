import { toFoldedGraphemes } from './to-folded-graphemes';

const LETTERS = 'asdfghjklqwertyuiopzxcvbnm';

// A label for each name that matches what the user typed, or null where none is due. Labels come
// from free letters, which never extend the search. A row that no typing can isolate always gets one;
// past the free letters, every row gets two letters.
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

  const isIsolated = extensions.map((texts, index) =>
    [...texts].some((text) =>
      extensions.every((other, otherIndex) => otherIndex === index || !other.has(text)),
    ),
  );

  const needed = isIsolated.filter((isolated) => !isolated).length;

  if (needed > free.length) {
    return pickTwoLetterLabels(names.length, free, blocked);
  }

  let spare = free.length - needed;

  const isLabelled = isIsolated.map((isolated) => {
    if (!isolated) {
      return true;
    }

    spare -= 1;

    return spare >= 0;
  });

  let next = 0;

  return isLabelled.map((labelled) => {
    if (!labelled) {
      return null;
    }

    next += 1;

    return free[next - 1] ?? null;
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

// Two letters for each of `count` rows. The first letter is a free one while any is left, so that
// typing a blocked letter still narrows the rows.
function pickTwoLetterLabels(
  count: number,
  free: readonly string[],
  blocked: ReadonlySet<string>,
): (string | null)[] {
  const firsts = [...free, ...LETTERS.split('').filter((letter) => blocked.has(letter))];

  return Array.from({ length: count }, (_, index) => {
    const first = firsts[Math.floor(index / LETTERS.length)];

    return first === undefined ? null : `${first}${LETTERS[index % LETTERS.length] ?? ''}`;
  });
}
