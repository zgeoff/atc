// A number to one decimal, which prints with no trailing zero.
export function roundTenth(value: number): number {
  return Number(value.toFixed(1));
}
