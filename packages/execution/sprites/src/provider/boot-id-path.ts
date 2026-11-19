// Where a Linux guest keeps the id of its current boot. A sprite that drops its memory boots again,
// and the id changes.
export const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
