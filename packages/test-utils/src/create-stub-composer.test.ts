import { expect, test } from 'bun:test';
import { spawn } from 'bun-pty';
import { createStubComposer } from './create-stub-composer';
import { KEYS } from './keys';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

/**
 * The composer running in a terminal of its own, with everything it prints
 * gathered into `output.text`, waiting until it is ready for input.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-stub-composer-');

  const pty = spawn(process.execPath, [createStubComposer(tmp.dir)], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: tmp.dir,
  });

  registerTestCleanup(() => {
    pty.kill();
  });

  const output = { text: '' };

  pty.onData((data) => {
    output.text += data;
  });

  await waitFor(() => {
    expect(output.text).toInclude('FAKE_COMPOSER_READY');
  });

  return { pty, output };
}

test('it turns bracketed paste on before it reports ready', async () => {
  const ctx = await setupTest();

  expect(ctx.output.text).toInclude('\u001B[?2004hFAKE_COMPOSER_READY\r');
});

test('it submits the typed text on a lone carriage return', async () => {
  const ctx = await setupTest();

  ctx.pty.write('hello');

  await waitFor(() => {
    expect(ctx.output.text).toInclude('RECEIVED:"hello"');
  });

  ctx.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.output.text).toInclude('SUBMIT:"hello"\r');
  });
});

test('it prints every byte received so far after each read', async () => {
  const ctx = await setupTest();

  ctx.pty.write('ab');

  await waitFor(() => {
    expect(ctx.output.text).toInclude('RECEIVED:"ab"');
  });

  ctx.pty.write('c');

  await waitFor(() => {
    expect(ctx.output.text).toInclude('RECEIVED:"abc"\r');
  });
});

test('it keeps the line breaks of a bracketed paste in the submission', async () => {
  const ctx = await setupTest();

  ctx.pty.write(`${KEYS.pasteOpen}first${KEYS.enter}second${KEYS.pasteClose}`);

  await waitFor(() => {
    expect(ctx.output.text).toInclude(
      `RECEIVED:${JSON.stringify(`${KEYS.pasteOpen}first${KEYS.enter}second${KEYS.pasteClose}`)}`,
    );
  });

  ctx.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`SUBMIT:"first\nsecond"`);
  });
});

test('it adds a line break for a lone line feed instead of submitting', async () => {
  const ctx = await setupTest();

  ctx.pty.write('first');

  await waitFor(() => {
    expect(ctx.output.text).toInclude('RECEIVED:"first"');
  });

  ctx.pty.write(KEYS.ctrlJ);

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`RECEIVED:"first\n"`);
  });

  ctx.pty.write('second');

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`RECEIVED:"first\nsecond"`);
  });

  ctx.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`SUBMIT:"first\nsecond"`);
  });
});

test('it keeps the line breaks of an unbracketed burst in the composer', async () => {
  const ctx = await setupTest();

  ctx.pty.write(`first${KEYS.enter}second`);

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`RECEIVED:"first\rsecond"`);
  });

  ctx.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`SUBMIT:"first\nsecond"`);
  });
});

test('it holds a paste marker split across two reads', async () => {
  const ctx = await setupTest();

  ctx.pty.write(KEYS.pasteOpen.slice(0, 4));

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`RECEIVED:"\u001b[20"`);
  });

  ctx.pty.write(`${KEYS.pasteOpen.slice(4)}a${KEYS.enter}b${KEYS.pasteClose}`);

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`\u001b[201~"`);
  });

  ctx.pty.write(KEYS.enter);

  await waitFor(() => {
    expect(ctx.output.text).toInclude(String.raw`SUBMIT:"a\nb"`);
  });
});
