export interface ProcessIO {
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly exit: (code: number) => void;
  readonly registerSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => Promise<void>) => void;
}

export const PROCESS_IO: ProcessIO = {
  print: (line) => {
    console.log(line);
  },
  printError: (line) => {
    console.error(line);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => {
    process.exit(code);
  },
  registerSignal: (signal, listener) => {
    process.on(signal, () => {
      void listener();
    });
  },
};
