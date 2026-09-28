import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ShellExecutor } from '../../src/shell-executor.js';
import { ShellExecutorConfigSchema, defaultShellEnv } from '../../src/config.js';
import type { AuditEntry } from '../../src/audit.js';

const defaultConfig = ShellExecutorConfigSchema.parse({
  workingDirectory: '/tmp',
  env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
});

describe('ShellExecutor', () => {
  describe('trustAll: true', () => {
    it('executes command bypassing policy', async () => {
      const executor = new ShellExecutor(defaultConfig, { trustAll: true });
      const result = await executor.execute('echo hello');
      expect(result.stdout.trim()).to.equal('hello');
      expect(result.exitCode).to.equal(0);
    });

    it('writes audit entries with source: trust', async () => {
      const entries: AuditEntry[] = [];
      const executor = new ShellExecutor(defaultConfig, {
        trustAll: true,
        auditWriter: async (e) => {
          entries.push(e);
        },
      });
      await executor.execute('echo audit');
      expect(entries.length).to.be.greaterThan(0);
      expect(entries[0].source).to.equal('trust');
      expect(entries[0].trustAll).to.equal(true);
    });
  });

  describe('policy denial', () => {
    it('returns error result when command matches denylist', async () => {
      const config = ShellExecutorConfigSchema.parse({
        workingDirectory: '/tmp',
        denylist: ['rm *'],
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      });
      const executor = new ShellExecutor(config);
      const result = await executor.execute('rm -rf /tmp/test');
      expect(result.exitCode).to.equal(1);
      expect(result.stderr).to.include('denied by policy');
    });

    it('writes audit entry with outcome: denied', async () => {
      const entries: AuditEntry[] = [];
      const config = ShellExecutorConfigSchema.parse({
        workingDirectory: '/tmp',
        denylist: ['rm *'],
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      });
      const executor = new ShellExecutor(config, {
        auditWriter: async (e) => {
          entries.push(e);
        },
      });
      await executor.execute('rm -rf /tmp/test');
      expect(entries[0].outcome).to.equal('denied');
      expect(entries[0].source).to.equal('policy');
    });
  });

  describe('policy allowlist', () => {
    it('executes command matching allowlist without approval callback', async () => {
      const config = ShellExecutorConfigSchema.parse({
        workingDirectory: '/tmp',
        allowlist: ['echo *'],
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      });
      const executor = new ShellExecutor(config);
      const result = await executor.execute('echo allowed');
      expect(result.stdout.trim()).to.equal('allowed');
    });
  });

  describe('session allowlist', () => {
    it('executes command matching session allowlist', async () => {
      const executor = new ShellExecutor(defaultConfig, {
        sessionAllowlist: ['echo *'],
      });
      const result = await executor.execute('echo session');
      expect(result.stdout.trim()).to.equal('session');
      expect(result.exitCode).to.equal(0);
    });

    it('writes audit entry with source: session-memory', async () => {
      const entries: AuditEntry[] = [];
      const executor = new ShellExecutor(defaultConfig, {
        sessionAllowlist: ['echo *'],
        auditWriter: async (e) => {
          entries.push(e);
        },
      });
      await executor.execute('echo session');
      expect(entries[0].source).to.equal('session-memory');
    });
  });

  describe('approval callback', () => {
    it('executes command when callback returns approved', async () => {
      const executor = new ShellExecutor(defaultConfig, {
        onApprovalRequired: async () => 'approved',
      });
      const result = await executor.execute('echo approved');
      expect(result.stdout.trim()).to.equal('approved');
    });

    it('returns error result when callback returns denied', async () => {
      const executor = new ShellExecutor(defaultConfig, {
        onApprovalRequired: async () => 'denied',
      });
      const result = await executor.execute('echo denied');
      expect(result.exitCode).to.equal(1);
      expect(result.stderr).to.include('rejected by user');
    });

    it('returns error when approval is needed but no callback configured', async () => {
      const executor = new ShellExecutor(defaultConfig);
      const result = await executor.execute('echo no-callback');
      expect(result.exitCode).to.equal(1);
      expect(result.stderr).to.include('no approval callback');
    });
  });

  describe('audit writer', () => {
    it('swallows errors from failing audit writer', async () => {
      const executor = new ShellExecutor(defaultConfig, {
        trustAll: true,
        auditWriter: async () => {
          throw new Error('audit db down');
        },
      });
      const result = await executor.execute('echo resilient');
      expect(result.stdout.trim()).to.equal('resilient');
    });
  });

  // Issue #220: configured env used to *replace* PATH/HOME/USER, so adding
  // GH_TOKEN left commands with no PATH and `gh` was "command not found".
  describe('environment (issue #220)', () => {
    const printEnv = 'echo "$PATH|$HOME|$GH_X"';

    it('gives commands the default PATH/HOME when no env is configured [unit]', async () => {
      const config = ShellExecutorConfigSchema.parse({ workingDirectory: '/tmp' });
      const result = await new ShellExecutor(config, { trustAll: true }).execute(printEnv);
      const [path, home] = result.stdout.trim().split('|');
      expect(path).to.equal(defaultShellEnv()['PATH']);
      expect(home).to.equal(defaultShellEnv()['HOME']);
    });

    it('layers configured env on top of the defaults instead of replacing them [unit]', async () => {
      const config = ShellExecutorConfigSchema.parse({
        workingDirectory: '/tmp',
        env: { GH_X: 'token-value' },
      });
      const result = await new ShellExecutor(config, { trustAll: true }).execute(printEnv);
      const [path, , ghX] = result.stdout.trim().split('|');
      expect(ghX, 'configured variable should reach the command').to.equal('token-value');
      expect(path, 'default PATH must survive a configured env').to.equal(
        defaultShellEnv()['PATH'],
      );
    });

    it('lets a configured PATH override the default [unit]', async () => {
      const config = ShellExecutorConfigSchema.parse({
        workingDirectory: '/tmp',
        env: { PATH: '/opt/custom/bin:/usr/bin:/bin' },
      });
      const result = await new ShellExecutor(config, { trustAll: true }).execute(printEnv);
      expect(result.stdout.trim().split('|')[0]).to.equal('/opt/custom/bin:/usr/bin:/bin');
    });

    it('defaults configured env to empty, leaving PATH/HOME/USER to spawn time [unit]', () => {
      expect(ShellExecutorConfigSchema.parse({}).env).to.deep.equal({});
    });
  });
});
