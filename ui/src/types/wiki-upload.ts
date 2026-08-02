export type UploadStage =
  | 'pending'
  | 'unpacking'
  | 'validating'
  | 'registering'
  | 'linting'
  | 'embedding'
  | 'done'
  | 'failed';

export interface LintFinding {
  check: string;
  severity: 'error' | 'warn' | 'info';
  page?: string;
  message: string;
}

export interface LintReport {
  ok: boolean;
  checks: LintFinding[];
}

export type UploadJobState =
  | { stage: 'pending' | 'unpacking' | 'validating' | 'registering' | 'linting' }
  | { stage: 'embedding'; pagesEmbedded: number; pagesTotal: number }
  | { stage: 'done'; wikiId: string; lintReport: LintReport }
  | { stage: 'failed'; error: string };

export interface UploadCapabilities {
  acceptedFormats: string[];
}
