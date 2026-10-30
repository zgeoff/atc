export interface AddedLine {
  readonly hash: string;

  // Relative to the repo root.
  readonly path: string;

  // The line's number in the file as the commit leaves it.
  readonly line: number;

  readonly text: string;
}

// The patch is `git log -p -U0 --format=%x00%h` output: each commit starts with a NUL and its hash,
// which no line of a patch can start with.
export function parseAddedLines(patch: string): AddedLine[] {
  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/u;
  const added: AddedLine[] = [];
  let hash = '';
  let path: string | null = null;
  let line = 0;

  // A file's header runs from its `diff --git` line to its first hunk. Inside a hunk, an added line
  // that starts with `++` reads like a `+++` header line, so the state tells the two apart.
  let inHeader = false;

  for (const text of patch.split('\n')) {
    if (text.startsWith('\0')) {
      hash = text.slice(1);
      path = null;
      inHeader = false;
    } else if (text.startsWith('diff --git ')) {
      path = null;
      inHeader = true;
    } else if (inHeader && text.startsWith('+++ ')) {
      path = parseNewPath(text.slice('+++ '.length));
    } else if (hunkHeader.test(text)) {
      line = Number(hunkHeader.exec(text)?.groups?.['start']);
      inHeader = false;
    } else if (!inHeader && path !== null && text.startsWith('+')) {
      added.push({ hash, path, line, text: text.slice(1) });

      line += 1;
    } else if (!inHeader && path !== null && text.startsWith(' ')) {
      // A repo's diff.interHunkContext joins nearby hunks with the unchanged lines between them,
      // even under -U0.
      line += 1;
    }
  }

  return added;
}

// `b/path`, or `/dev/null` for a file the commit deletes. git ends the name with a tab when it holds
// a space, and quotes it in C style when it holds a tab, a newline, a quote or a backslash.
function parseNewPath(name: string): string | null {
  const bare = name.replace(/\t$/u, '');

  if (bare === '/dev/null') {
    return null;
  }

  const unquoted =
    bare.startsWith('"') && bare.endsWith('"') ? parseQuotedName(bare.slice(1, -1)) : bare;

  return unquoted.replace(/^b\//u, '');
}

const ESCAPED_BYTES: ReadonlyMap<string, number> = new Map([
  ['a', 0x07],
  ['b', 0x08],
  ['t', 0x09],
  ['n', 0x0a],
  ['v', 0x0b],
  ['f', 0x0c],
  ['r', 0x0d],
  ['"', 0x22],
  ['\\', 0x5c],
]);

// git writes each escaped byte as a letter or as three octal digits, and the bytes are UTF-8.
function parseQuotedName(quoted: string): string {
  const bytes: number[] = [];

  const encoder = new TextEncoder();

  for (let index = 0; index < quoted.length; index += 1) {
    // A character outside the Basic Multilingual Plane, such as an emoji, spans two code units.
    const character = String.fromCodePoint(quoted.codePointAt(index) ?? 0);

    if (character !== '\\') {
      bytes.push(...encoder.encode(character));

      index += character.length - 1;
      continue;
    }

    const next = quoted.charAt(index + 1);
    const octal = /^[0-7]{3}/u.exec(quoted.slice(index + 1))?.[0];

    if (octal === undefined) {
      bytes.push(ESCAPED_BYTES.get(next) ?? next.codePointAt(0) ?? 0x5c);

      index += 1;
    } else {
      bytes.push(Number.parseInt(octal, 8));

      index += 3;
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}
