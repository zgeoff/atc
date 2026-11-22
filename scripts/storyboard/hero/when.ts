export interface When {
  // a change id, a mark of one, or a built-in instant of the loop
  readonly reference: string;
  readonly offsetS: number;
}

export function buildWhen(reference: string, offsetS = 0): When {
  return { reference, offsetS };
}
