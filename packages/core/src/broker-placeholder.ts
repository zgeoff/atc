// The broker overwrites the credential header on each request it brokers, so
// this value only gets a tool past its own check for a credential, and the
// session never sees the real one.
export const BROKER_PLACEHOLDER = 'broker-placeholder';
