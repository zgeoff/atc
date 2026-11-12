// Every service token starts with this, so a bearer is routed to the token
// file or to the authorization server's database by its first characters.
export const SERVICE_TOKEN_PREFIX = 'atcs_';
