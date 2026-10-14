export type AuditEntry = {
  timestamp: string;
  command: string;
  outcome: 'allowed' | 'denied' | 'approved' | 'rejected' | 'error';
  // 'sleep-guard': refused by detectLongSleep before policy/approval ran.
  // 'auto': a requires-approval command that ran without an approval
  // callback because the caller opted into autoApprove — distinct from
  // 'trust' (trustAll bypasses policy entirely, including the denylist).
  source: 'trust' | 'policy' | 'session-memory' | 'user' | 'sleep-guard' | 'auto';
  exitCode?: number;
  threadId?: string;
  trustAll: boolean;
};

export type AuditWriter = (entry: AuditEntry) => Promise<void>;
