import type { HarnessAttachment } from '@atc/plugin-api';

export function buildStubFailingAttachmentListener(
  message: string,
): (attachment: HarnessAttachment) => void {
  return (attachment) => {
    if (attachment === 'attached') {
      throw new Error(message);
    }
  };
}
