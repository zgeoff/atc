import { toFoldedGraphemes } from './to-folded-graphemes';

const LETTERS = 'asdfghjklqwertyuiopzxcvbnm';

// A label for each name that matches what the user typed and shows on screen, or null where none is
// due. Free letters, which never extend the search in any matching name, come first. A shown row that
// no typing can isolate always gets one; past the free letters, every shown row gets two letters.
export function pickJumpLabels(
  names: readonly string[],
  typed: string,
  isShown: readonly boolean[],
): (string | null)[] {
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
  const shownCount = isShown.filter(Boolean).length;

  const isIsolated = extensions.map((texts, index) =>
    [...texts].some((text) =>
      extensions.every((other, otherIndex) => otherIndex === index || !other.has(text)),
    ),
  );

  const needed = names.filter(
    (_name, index) => isShown[index] === true && !isIsolated[index],
  ).length;

  if (shownCount > free.length && needed > free.length) {
    return toRowLabels(isShown, buildTwoLetterLabels(shownCount, free, blocked));
  }

  let spare = shownCount > free.length ? free.length - needed : shownCount;

  const isLabelled = names.map((_name, index) => {
    if (isShown[index] !== true) {
      return false;
    }

    if (isIsolated[index] !== true) {
      return true;
    }

    spare -= 1;

    return spare >= 0;
  });

  return toRowLabels(isLabelled, free);
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

// Hands the labels out in order, one to each row that takes one.
function toRowLabels(isLabelled: readonly boolean[], labels: readonly string[]): (string | null)[] {
  let next = 0;

  return isLabelled.map((labelled) => {
    if (!labelled) {
      return null;
    }

    next += 1;

    return labels[next - 1] ?? null;
  });
}

// Two letters for each of `count` rows. The first letter is a free one while any is left, so that
// typing a blocked letter still narrows the rows.
function buildTwoLetterLabels(
  count: number,
  free: readonly string[],
  blocked: ReadonlySet<string>,
): string[] {
  const firsts = [...free, ...LETTERS.split('').filter((letter) => blocked.has(letter))];

  return Array.from({ length: Math.min(count, firsts.length * LETTERS.length) }, (_, index) => {
    const first = firsts[Math.floor(index / LETTERS.length)] ?? '';

    return `${first}${LETTERS[index % LETTERS.length] ?? ''}`;
  });
}
