import { extname } from 'node:path';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveSkillScope, type ResolveSkillScopeDeps } from './skill-scope-resolver.js';

const TestSkillArtifactSchema = z.object({
  skill: z.string().describe('The skill this script belongs to.'),
  name: z.string().describe('The script filename to dry-run (e.g. "run.py", "check.js").'),
  args: z
    .array(z.string())
    .optional()
    .describe('Arguments to pass — only used for a Python (.py) script.'),
});

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// A dry-run sanity check during authoring, not how a skill's script gets
// invoked for real — named test_skill_artifact (not run_skill_artifact) so
// the model doesn't read it as an invocation path. Only available while the
// create-skill skill is active. Accepts the same injectable deps as
// resolveSkillScope for testability.
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

      const ext = extname(name);
      if (ext === '.py') {
        const result = await manager.runPythonScript(skill, name, args ?? []);
        return JSON.stringify(result);
      }
      if (JS_EXTENSIONS.has(ext)) {
        // runScript executes in a vm sandbox with no stdout/stderr/exit-code
        // capture — unlike the Python path, only the script's own return
        // value comes back, and the `args` array has no effect here
        // (runScript takes a context object, not an argv list). console.*
        // output inside the script goes to the server's own log, not to
        // this result.
        try {
          const result = await manager.runScript(skill, name, {});
          return JSON.stringify({
            result,
            note: 'console output from this script goes to the server log, not here; args are ignored for .js/.mjs/.cjs scripts.',
          });
        } catch (err) {
          return `Script "${name}" threw: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return `"${name}" is not a script this tool can dry-run (only .py and .js/.mjs/.cjs are supported).`;
    },
    {
      name: 'test_skill_artifact',
      description:
        'Dry-run a script artifact right after writing it, to surface a broken script during authoring ' +
        'rather than the next time the skill is actually invoked. For a Python script this reports real ' +
        'stdout/stderr/exit code; for a JavaScript script it reports only the return value (no stdout ' +
        'capture exists for that path). Only available once the /create-skill skill has been invoked.',
      schema: TestSkillArtifactSchema,
    },
  );
}
