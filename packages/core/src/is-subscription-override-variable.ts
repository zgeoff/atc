import { CLAUDE_CREDENTIAL_VARIABLES } from './claude-credential-variables';
import { isBrokerVariable } from './is-broker-variable';
import { OUTRANKING_VARIABLES } from './outranking-variables';

/**
 * Whether a variable set in a Claude session's environment would override
 * the subscription sign-in or route the CLI around impd's broker: an
 * outranking credential, endpoint, or provider selector, the subscription
 * token variable itself, or a proxy or CA variable.
 */
export function isSubscriptionOverrideVariable(key: string): boolean {
  return (
    OUTRANKING_VARIABLES.has(key) ||
    key === CLAUDE_CREDENTIAL_VARIABLES.oauthToken ||
    isBrokerVariable(key)
  );
}
