const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

export function isEnvName(key: string): boolean {
  return ENV_NAME.test(key);
}
