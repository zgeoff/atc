// Claude Code gives each MCP server 30 s to answer initialize. A guest's first start has
// stalled past that, leaving the session without its atc tools.
export const ATC_MCP_ENV: Readonly<Record<string, string>> = { MCP_TIMEOUT: '120000' };
