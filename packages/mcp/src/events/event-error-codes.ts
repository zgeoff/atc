// ChatGPT's MCP Events guide names -32015 for a callback that fails
// verification, where the draft extension allocates -32027 provisionally, and
// ChatGPT is the client that subscribes.
export const EVENT_ERROR_CODES = {
  invalidParams: -32_602,
  notFound: -32_023,
  unsupported: -32_026,
  callbackEndpoint: -32_015,
} as const;
