/**
 * Whether an imp name matches one of a token's imp patterns, as impd
 * matches them: each pattern is an imp name with `*` for any run of
 * characters, including none, so `dev-*` matches `dev-` and `dev-a1`, and
 * a pattern without `*` matches only its own name.
 */
export function isImpNameAllowed(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => isPatternMatch(pattern, name));
}

function isPatternMatch(pattern: string, name: string): boolean {
  const [first = '', ...rest] = pattern.split('*');
  const last = rest.pop();

  if (last === undefined) {
    return name === first;
  }

  if (name.length < first.length + last.length || !name.startsWith(first) || !name.endsWith(last)) {
    return false;
  }

  // Each middle part in order, between the prefix and the suffix.
  let at = first.length;
  const end = name.length - last.length;

  for (const part of rest) {
    const found = name.indexOf(part, at);

    if (found === -1 || found + part.length > end) {
      return false;
    }

    at = found + part.length;
  }

  return true;
}
