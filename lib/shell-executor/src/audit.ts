export type AuditEntry = {
  timestamp: string;
  command: string;
  outcome: 'allowed' | 'denied' | 'approved' | 'rejected' | 'error';
  source: 'trust' | 'policy' | 'session-memory' | 'user';
  exitCode?: number;
  threadId?: string;
  trustAll: boolean;
};

export type AuditWriter = (entry: AuditEntry) => Promise<void>;
