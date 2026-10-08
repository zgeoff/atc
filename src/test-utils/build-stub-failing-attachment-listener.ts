import type { HarnessAttachment } from '../daemon/execution-provider';

/**
 * An attachment listener that fails as a listener whose write to a closed
 * peer fails: it throws an error with the given message each time a
 * connection is attached, and returns quietly while one is reattaching.
 */
export function buildStubFailingAttachmentListener(
  message: string,
): (attachment: HarnessAttachment) => void {
  return (attachment) => {
    if (attachment === 'attached') {
      throw new Error(message);
    }
  };
}
