export type ShellCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ApprovalCallback = (
  command: string,
  reason?: string,
) => Promise<'approved' | 'denied'>;
