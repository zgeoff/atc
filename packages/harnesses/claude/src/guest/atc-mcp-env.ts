// Claude Code gives each MCP server 30 s to answer initialize, and a guest's first
// start has stalled past that, so the session started without its atc tools; a
// settings env block that sets its own MCP_TIMEOUT still wins over this one.
export const ATC_MCP_ENV: Readonly<Record<string, string>> = { MCP_TIMEOUT: '120000' };
