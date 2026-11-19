import { readFileSync } from 'node:fs';
import { isRecord } from '@atc/core';
import { configFile } from '../host/constants';
import { collectMCPHTTPConfig } from './collect-mcp-http-config';
import type { MCPHTTPConfig } from './collect-mcp-http-config';

export function loadMCPHTTPConfig(): MCPHTTPConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(configFile, 'utf8'));
    const section = isRecord(raw) ? raw['mcpHTTP'] : undefined;

    return collectMCPHTTPConfig(section);
  } catch {
    return collectMCPHTTPConfig(undefined);
  }
}
