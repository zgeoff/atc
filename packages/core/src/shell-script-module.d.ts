/**
 * A shell program imported as text (`with { type: 'text' }`): Bun inlines
 * the file's contents into the bundle and the compiled binary, so the
 * program travels with the code that runs it.
 */
declare module '*.sh' {
  const text: string;
  export default text;
}
