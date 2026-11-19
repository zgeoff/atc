import type { PublishedRecord } from '@atcx/contract';

interface ScopeCheckout {
  readonly path: string;
  readonly branch: string | null;
}

interface ScopeReplyChannel {
  readonly tool: string;
  readonly field: string;
  readonly recipient: string;
}

// The auto-mode launcher refuses a scope file that holds a field its format does not define.
// The format is documented in docs/guides/scope-file.md.
export interface ScopeFile {
  readonly format: 'auto-mode.scope';
  readonly version: 1;
  readonly paths: readonly string[];
  readonly workspace: ScopeCheckout;
  readonly worktrees: readonly ScopeCheckout[];
  readonly branches: readonly { readonly name: string; readonly repo: string }[];
  readonly pullRequests: readonly {
    readonly repo: string;
    readonly number: number;
    readonly branch: string;
    readonly url: string;
  }[];
  readonly replyChannels: readonly ScopeReplyChannel[];
}

// Claude Code names an MCP tool mcp__<server>__<tool>, and the server is registered under the
// name atc.
const MESSAGE_SEND_TOOL = 'mcp__atc__atc_message_send';

export function buildScopeFile(record: PublishedRecord): ScopeFile {
  const scope = record.scope;

  return {
    format: 'auto-mode.scope',
    version: 1,
    paths: record.scratch === null ? [] : [record.scratch],
    workspace: { path: scope.workspace.path, branch: scope.workspace.branch },
    worktrees: scope.worktrees.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
    })),
    branches: scope.branches.map((branch) => ({ name: branch.name, repo: branch.repo })),
    pullRequests: scope.pullRequests.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      branch: pr.branch,
      url: pr.url,
    })),
    replyChannels:
      record.spawner === null
        ? []
        : [{ tool: MESSAGE_SEND_TOOL, field: 'session', recipient: record.spawner }],
  };
}
