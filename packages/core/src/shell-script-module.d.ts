// Bun inlines an imported shell program into the bundle and the compiled
// binary, so the program travels with the code that runs it.
declare module '*.sh' {
  const text: string;
  export default text;
}
