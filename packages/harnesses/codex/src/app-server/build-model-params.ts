export function buildModelParams(model: string | undefined): { model?: string } {
  return model === undefined ? {} : { model };
}
