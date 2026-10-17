import { CLAUDE_CREDENTIAL_VARIABLES } from './claude-credential-variables';
import { isBrokerVariable } from './is-broker-variable';
import { OUTRANKING_VARIABLES } from './outranking-variables';

export function isSubscriptionOverrideVariable(key: string): boolean {
  return (
    OUTRANKING_VARIABLES.has(key) ||
    key === CLAUDE_CREDENTIAL_VARIABLES.oauthToken ||
    isBrokerVariable(key)
  );
}
