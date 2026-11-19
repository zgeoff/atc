// All box rows are built as {styled, plainWidth} pairs so centering and edge
// alignment never depend on ANSI-stripped length math at draw time.
export interface Row {
  readonly styled: string;
  readonly width: number;
}
