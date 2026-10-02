import { DaemonError } from '../protocol/daemon-error';
import type { ExecutionCapability, ExecutionProvider } from './execution-provider';

/**
 * Throws `unsupported_operation` when the provider does not declare the
 * capability, so a request the host cannot serve is refused with that code
 * before any operation starts.
 */
export function requireCapability(
  provider: ExecutionProvider,
  capability: ExecutionCapability,
): void {
  if (provider.capabilities[capability]) {
    return;
  }

  throw new DaemonError(
    'unsupported_operation',
    `the ${provider.kind} execution provider does not support ${capability}`,
    { provider: provider.kind, capability },
  );
}
