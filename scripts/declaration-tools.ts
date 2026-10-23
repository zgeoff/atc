import { readFileSync, writeFileSync } from 'node:fs';
import type { DeclarationTools } from './write-contract-declarations';

export const DECLARATION_TOOLS: DeclarationTools = {
  runCompiler: async (command, cwd) => {
    const compiler = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
      compiler.exited,
    ]);

    return { exitCode, output: `${stdout}${stderr}` };
  },
  listDeclarations: (directory) => [...new Bun.Glob('**/*.d.ts').scanSync({ cwd: directory })],
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, text) => {
    writeFileSync(path, text);
  },
};
