type AccessStep =
  | { readonly kind: 'settle' }
  | { readonly kind: 'cut' }
  | { readonly kind: 'recheck' }
  | { readonly kind: 'send' };

interface AccessCheck {
  // Whether the subscription is gone, so the event needs no delivery.
  readonly isGone: boolean;
  readonly reads: boolean;
  readonly isStopped: boolean;

  // Whether the attempt before this check already waited out a lost grant.
  readonly isRechecking: boolean;
}

// The authorization server rotates a refresh token in two writes, so the
// first check that finds no grant with read waits and checks once more before
// it cuts the delivery short.
export function pickAccessStep(check: AccessCheck): AccessStep {
  if (check.isGone) {
    return { kind: 'settle' };
  }

  if (check.reads && !check.isStopped) {
    return { kind: 'send' };
  }

  if (check.isRechecking || check.isStopped) {
    return { kind: 'cut' };
  }

  return { kind: 'recheck' };
}
