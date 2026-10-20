import { extname } from 'node:path';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import type { ScriptResult } from '@tkottke90/skills-manager';
import { env } from '../../config/env.js';
import { resolveSkillScope, type ResolveSkillScopeDeps } from './skill-scope-resolver.js';

const TestSkillArtifactSchema = z.object({
  skill: z.string().describe('The skill this script belongs to.'),
  name: z
    .string()
    .describe('The script filename to dry-run (e.g. "run.py", "check.sh", "check.js").'),
  args: z.array(z.string()).optional().describe('Arguments to pass to the script.'),
});

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// A dry-run sanity check during authoring, not how a skill's script gets
// invoked for real — named test_skill_artifact (not run_skill_artifact) so
// the model doesn't read it as an invocation path. Only available while the
// create-skill skill is active. Accepts the same injectable deps as
// resolveSkillScope for testability. Shares the same configurable timeout as
// every other skill script execution path, including the production
// run_skill_script tool (ADR-0021) — this is no longer the unbounded path it
// used to be.
export function makeTestSkillArtifactTool(deps: ResolveSkillScopeDeps = {}) {
  return tool(
    async ({ skill, name, args }, runtime: ToolRuntime) => {
      const workspaceId = runtime.configurable?.workspaceId as string | undefined;
      const resolution = await resolveSkillScope(skill, workspaceId, deps);
      if (resolution.kind === 'not-found') {
        return `No skill named "${skill}" found in the app-wide Skill Manager${
          workspaceId ? " or this workspace's .agents/skills" : ''
        }.`;
      }
      if (resolution.kind === 'ambiguous') {
        return `"${skill}" exists both app-wide and in this workspace — ask the user (via ask_user) which one they mean first.`;
      }

      const { manager, scope } = resolution;
      if (scope === 'workspace') await manager.boot();

      const timeoutMs = env.skills.scriptTimeoutMs;
      const ext = extname(name);
      let result: ScriptResult;
      if (ext === '.py') {
        result = await manager.runPythonScript(skill, name, args ?? [], timeoutMs);
      } else if (ext === '.sh') {
        result = await manager.runShellScript(skill, name, args ?? [], timeoutMs);
      } else if (JS_EXTENSIONS.has(ext)) {
        result = await manager.runScript(skill, name, { args: args ?? [], timeoutMs });
      } else {
        return `"${name}" is not a script this tool can dry-run (only .py, .sh, and .js/.mjs/.cjs are supported).`;
      }
      return JSON.stringify(result);
    },
    {
      name: 'test_skill_artifact',
      description:
        'Dry-run a script artifact right after writing it, to surface a broken script during authoring ' +
        'rather than the next time the skill is actually invoked. Reports real stdout/stderr/exit code ' +
        'for every supported script type. Only available once the /create-skill skill has been invoked.',
      schema: TestSkillArtifactSchema,
    },
  );
}
