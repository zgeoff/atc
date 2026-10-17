// every thread and turn request carries the spawn's model, if any, so a message that arrives
// before the terminal applies that model still runs on it
export function buildModelParams(model: string | undefined): { model?: string } {
  return model === undefined ? {} : { model };
}
