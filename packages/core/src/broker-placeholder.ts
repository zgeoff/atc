/**
 * The value a brokered session holds in place of a credential. impd's broker
 * swaps the real credential in on the host's side, so the session never
 * sees it.
 */
export const BROKER_PLACEHOLDER = 'imp-broker-placeholder';
