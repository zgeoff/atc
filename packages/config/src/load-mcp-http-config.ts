import { readFileSync } from 'node:fs';
import { isRecord } from '@atc/core';
import { collectMCPHTTPConfig } from './collect-mcp-http-config';
import type { MCPHTTPConfig } from './collect-mcp-http-config';
import { configFile } from './host/process-paths';

/**
 * Reads config.json's `mcpHTTP` section for `atc mcp --http`. Nothing else in
 * atc reads it, and a missing or unreadable file means every default.
 */
export function loadMCPHTTPConfig(): MCPHTTPConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(configFile, 'utf8'));
    const section = isRecord(raw) ? raw['mcpHTTP'] : undefined;

    return collectMCPHTTPConfig(section);
  } catch {
    return collectMCPHTTPConfig(undefined);
  }
}
