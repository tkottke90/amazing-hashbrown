import { tmpdir } from 'node:os';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { configManager } from '../../config/env.js';
import { ShellExecSchema, makeShellExecTool, longSleepRefusal } from './shell-exec.tool.js';

describe('agents/tools/shell-exec', () => {
  describe('ShellExecSchema', () => {
    it('rejects a call with no reason field', () => {
      expect(() => ShellExecSchema.parse({ command: 'ls' })).to.throw();
    });

    it('rejects a call with an empty-string reason', () => {
      expect(() => ShellExecSchema.parse({ command: 'ls', reason: '' })).to.throw();
    });

    it('accepts a call with a non-empty reason', () => {
      expect(() => ShellExecSchema.parse({ command: 'ls', reason: 'list files' })).to.not.throw();
    });
  });

  describe('sleep guard', () => {
    // Empty allowlist: any command that reaches policy would need approval,
    // and interrupt() throws outside a graph — so a returned refusal proves
    // the guard ran before policy and the approval prompt.
    let previousTools: unknown;
    before(() => {
      previousTools = configManager.get('tools');
      configManager.set('tools', {
        shell_exec: { workingDirectory: tmpdir(), allowlist: ['sleep 0'] },
      });
    });
    after(() => configManager.set('tools', previousTools));

    const input = (command: string) => ({ command, reason: 'wait for the deploy' });

    it('refuses a long sleep before any approval prompt, pointing at schedule_wakeup [unit]', async () => {
      const result = await makeShellExecTool(undefined, { wakeupAvailable: true }).invoke(
        input('sleep 900 && kubectl rollout status deploy/api'),
      );
      expect(result).to.equal(longSleepRefusal(900, true));
      expect(result).to.include('schedule_wakeup');
    });

    it('does not mention schedule_wakeup to an agent that has no such tool [unit]', async () => {
      const result = await makeShellExecTool().invoke(input('sleep 600'));
      expect(result).to.equal(longSleepRefusal(600, false));
      expect(result).not.to.include('schedule_wakeup');
    });

    it('still runs a short pause normally [unit]', async () => {
      const result = await makeShellExecTool(undefined, { wakeupAvailable: true }).invoke(
        input('sleep 0'),
      );
      expect(result).to.equal('exit 0');
    });
  });
});
