import { createStubBin } from './create-stub-bin';

// Modelled on the composers the Codex and Grok TUIs draw: raw mode with
// bracketed paste on, where each read is one input event batch and a read of
// more than one byte outside a paste is a paste burst.
export function createStubComposer(directory: string): string {
  return createStubBin(
    directory,
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
