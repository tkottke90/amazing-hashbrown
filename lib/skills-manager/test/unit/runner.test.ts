import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runJsScript,
  runPythonScript,
  runShellScript,
  buildCommand,
  buildShellCommand,
} from '../../src/internal/runner.js';

// No mocking library exists anywhere in this monorepo (no sinon/proxyquire/
// esmock in any workspace's package.json) — these run real spawned
// processes against real temp-dir scripts, same real-instance preference
// this repo's tool tests already use for SkillsManager/WorkspaceStore.
describe('internal/runner', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('buildCommand [unit]', () => {
    it('quotes the script path and args for python3 mode', () => {
      expect(buildCommand('python3', '/skill', '/skill/scripts/a.py', ['x', 'y'])).to.equal(
        'python3 "/skill/scripts/a.py" "x" "y"',
      );
    });

    it('routes through uv run for uv mode', () => {
      expect(buildCommand('uv', '/skill', '/skill/scripts/a.py', [])).to.equal(
        'uv run "/skill/scripts/a.py"',
      );
    });

    it('uses the skill-local venv python for venv mode', () => {
      expect(buildCommand('venv', '/skill', '/skill/scripts/a.py', [])).to.equal(
        '"/skill/.venv/bin/python" "/skill/scripts/a.py"',
      );
    });
  });

  describe('buildShellCommand [unit]', () => {
    it('quotes the script path and args', () => {
      expect(buildShellCommand('/skill/scripts/a.sh', ['x', 'y'])).to.equal(
        'sh "/skill/scripts/a.sh" "x" "y"',
      );
    });

    it('omits the trailing space when there are no args', () => {
      expect(buildShellCommand('/skill/scripts/a.sh', [])).to.equal('sh "/skill/scripts/a.sh"');
    });
  });

  describe('runJsScript', () => {
    it('spawns a real node process and captures stdout/exitCode [unit]', async () => {
      const scriptPath = join(dir, 'a.js');
      await writeFile(scriptPath, 'console.log("hi from js")');
      const result = await runJsScript(scriptPath);
      expect(result.stdout.trim()).to.equal('hi from js');
      expect(result.exitCode).to.equal(0);
    });

    it('passes args through as argv [unit]', async () => {
      const scriptPath = join(dir, 'args.js');
      await writeFile(scriptPath, 'console.log(process.argv.slice(2).join(","))');
      const result = await runJsScript(scriptPath, ['a', 'b']);
      expect(result.stdout.trim()).to.equal('a,b');
    });

    it('delivers context as JSON via SKILL_SCRIPT_CONTEXT [unit]', async () => {
      const scriptPath = join(dir, 'ctx.js');
      await writeFile(scriptPath, 'console.log(JSON.parse(process.env.SKILL_SCRIPT_CONTEXT).foo)');
      const result = await runJsScript(scriptPath, [], { foo: 'bar' });
      expect(result.stdout.trim()).to.equal('bar');
    });

    it('kills a script that outlives its timeout [unit]', async () => {
      const scriptPath = join(dir, 'hang.js');
      await writeFile(scriptPath, 'setInterval(() => {}, 1000)');
      const result = await runJsScript(scriptPath, [], {}, 100);
      expect(result.exitCode).to.not.equal(0);
      expect(result.stderr).to.include('exceeding');
    }).timeout(5000);
  });

  describe('runPythonScript', () => {
    it('spawns a real python3 process and captures stdout/exitCode [unit]', async () => {
      const scriptPath = join(dir, 'a.py');
      await writeFile(scriptPath, 'print("hi from python")');
      const result = await runPythonScript(dir, scriptPath);
      expect(result.stdout.trim()).to.equal('hi from python');
      expect(result.exitCode).to.equal(0);
    });

    it('kills a script that outlives its timeout [unit]', async () => {
      const scriptPath = join(dir, 'hang.py');
      await writeFile(scriptPath, 'import time\ntime.sleep(5)');
      const result = await runPythonScript(dir, scriptPath, [], 100);
      expect(result.exitCode).to.not.equal(0);
      expect(result.stderr).to.include('exceeding');
    }).timeout(5000);
  });

  describe('runShellScript', () => {
    it('spawns a real shell process and captures stdout/exitCode [unit]', async () => {
      const scriptPath = join(dir, 'a.sh');
      await writeFile(scriptPath, 'echo "hi from shell"');
      const result = await runShellScript(scriptPath);
      expect(result.stdout.trim()).to.equal('hi from shell');
      expect(result.exitCode).to.equal(0);
    });

    it('passes args through [unit]', async () => {
      const scriptPath = join(dir, 'args.sh');
      await writeFile(scriptPath, 'echo "$1,$2"');
      const result = await runShellScript(scriptPath, ['a', 'b']);
      expect(result.stdout.trim()).to.equal('a,b');
    });

    it('kills a script that outlives its timeout [unit]', async () => {
      const scriptPath = join(dir, 'hang.sh');
      await writeFile(scriptPath, 'sleep 5');
      const result = await runShellScript(scriptPath, [], 100);
      expect(result.exitCode).to.not.equal(0);
      expect(result.stderr).to.include('exceeding');
    }).timeout(5000);

    it('runs unbounded when no timeoutMs is given [unit]', async () => {
      const scriptPath = join(dir, 'quick.sh');
      await writeFile(scriptPath, 'echo quick');
      const result = await runShellScript(scriptPath);
      expect(result.stdout.trim()).to.equal('quick');
      expect(result.exitCode).to.equal(0);
    });
  });
});
