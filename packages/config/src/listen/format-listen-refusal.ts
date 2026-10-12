/**
 * The refusal of a `--listen` host outside the ranges a listener may bind,
 * with the ranges it may bind instead.
 */
export function formatListenRefusal(host: string): string {
  return `--listen refuses '${host}': bind a loopback address or one in 100.64.0.0/10 or fd7a:115c:a1e4::/48`;
}
