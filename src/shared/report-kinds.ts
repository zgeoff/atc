export const REPORT_KINDS = ['answered'] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];
