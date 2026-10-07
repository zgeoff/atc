import { createStubBin } from './create-stub-bin';

/**
 * Creates the composer the stub agents finish in, as `fake-composer.js`
 * under the directory, and returns its path; run it with bun. It is modelled
 * on the TUIs Codex and Grok draw: raw mode with bracketed paste on. Each
 * read is one input event batch. A bracketed paste lands in the composer
 * whole, newlines kept; a lone CR outside a paste submits; a lone LF is
 * Ctrl-J and adds a newline; any other read of more than one byte is a paste
 * burst whose line breaks stay in the composer. A read that ends partway
 * into a paste marker holds that part for the next read. It prints
 * `FAKE_COMPOSER_READY` once paste mode is on, every byte received so far as
 * `RECEIVED:<json>` after each read, and each submission as `SUBMIT:<json>`.
 */
export function createStubComposer(dir: string): string {
  return createStubBin(
    dir,
    'fake-composer.js',
    String.raw`const OPEN = '\u001B[200~';
const CLOSE = '\u001B[201~';
let composer = '';
let pasting = false;
let held = '';
let received = '';
process.stdin.setRawMode(true);
process.stdout.write('\u001B[?2004hFAKE_COMPOSER_READY\r\n');
process.stdin.on('data', (buf) => {
  const chunk = buf.toString('utf8');
  received += chunk;
  process.stdout.write('RECEIVED:' + JSON.stringify(received) + '\r\n');
  let rest = held + chunk;
  held = '';
  const cut = rest.lastIndexOf('\u001B');
  const tail = cut === -1 ? '' : rest.slice(cut);
  if (tail !== '' && tail.length < CLOSE.length && (OPEN.startsWith(tail) || CLOSE.startsWith(tail))) {
    held = tail;
    rest = rest.slice(0, cut);
  }
  while (rest !== '') {
    if (pasting) {
      const end = rest.indexOf(CLOSE);
      composer += (end === -1 ? rest : rest.slice(0, end)).replaceAll('\r', '\n');
      pasting = end === -1;
      rest = end === -1 ? '' : rest.slice(end + CLOSE.length);
      continue;
    }
    if (rest.startsWith(OPEN)) {
      pasting = true;
      rest = rest.slice(OPEN.length);
      continue;
    }
    const next = rest.indexOf(OPEN);
    const plain = next === -1 ? rest : rest.slice(0, next);
    rest = next === -1 ? '' : rest.slice(next);
    if (plain === '\r') {
      process.stdout.write('SUBMIT:' + JSON.stringify(composer) + '\r\n');
      composer = '';
    } else {
      composer += plain.replaceAll('\r', '\n');
    }
  }
});
`,
  );
}
