export type AuditEntry = {
  timestamp: string;
  command: string;
  outcome: 'allowed' | 'denied' | 'approved' | 'rejected' | 'error';
  // 'sleep-guard': refused by detectLongSleep before policy/approval ran.
  source: 'trust' | 'policy' | 'session-memory' | 'user' | 'sleep-guard';
  exitCode?: number;
  threadId?: string;
  trustAll: boolean;
};

export type AuditWriter = (entry: AuditEntry) => Promise<void>;
