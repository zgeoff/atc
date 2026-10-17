// The exit an imp without gzip answers a transfer with: EX_UNAVAILABLE,
// which neither mkdir nor tar uses.
export const NO_GZIP_CODE = 69;
