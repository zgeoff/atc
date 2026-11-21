let sink: (text: string) => void = writeToStdout;

// Routes what the screens draw. The TUI points it at its compositor, which draws the text into a
// layer in place of writing it to the terminal.
export function installScreenSink(write: (text: string) => void): void {
  sink = write;
}

export function writeOut(text: string) {
  sink(text);
}

function writeToStdout(text: string): void {
  process.stdout.write(text);
}
