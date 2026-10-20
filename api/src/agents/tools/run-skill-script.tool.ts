import { extname } from 'node:path';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { isSafeBasename, type ScriptResult } from '@tkottke90/skills-manager';
import { env } from '../../config/env.js';
import { resolveSkillScope, type ResolveSkillScopeDeps } from './skill-scope-resolver.js';

// .passthrough(), not the zod default of stripping unknown keys: the
// Active Skill the middleware injects (see skill-scoped-tools.middleware.ts)
// arrives as an extra key on this same object, never declared here so the
// model-visible schema never advertises it.
const RunSkillScriptSchema = z
  .object({
    name: z
      .string()
      .describe('The script filename to run (e.g. "check.sh", "run.py", "extract.js").'),
    args: z.array(z.string()).optional().describe('Arguments to pass to the script.'),
  })
  .passthrough();

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// A Skill-Scoped Tool (see GLOSSARY.md § Skill Invocation & Runtime Access):
// deliberately takes no skill argument, same reasoning as
// read-skill-reference.tool.ts. Unlike test_skill_artifact (an authoring-
// time dry-run a human is actively supervising), this tool is reachable
// during ordinary, unsupervised skill use, so every script run here is
// bounded by the same configurable timeout that governs every other skill
// script execution path (ADR-0021).
export function makeRunSkillScriptTool(deps: ResolveSkillScopeDeps = {}) {
  return tool(
    async ({ name, args, activeSkill }, runtime: ToolRuntime) => {
      const skill = activeSkill as string | null | undefined;
      if (!skill) {
        return 'No skill is currently active — this tool is only available while a skill is active.';
      }
      if (!isSafeBasename(name)) {
        return `"${name}" is not a safe file name — use letters, numbers, dots, dashes, or underscores only, with no path separators.`;
      }

      const workspaceId = runtime.configurable?.workspaceId as string | undefined;
      const resolution = await resolveSkillScope(skill, workspaceId, deps);
      if (resolution.kind === 'not-found') {
        return `The active skill "${skill}" could not be resolved.`;
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
        return `"${name}" is not a script this tool can run (only .py, .sh, and .js/.mjs/.cjs are supported).`;
      }

      return JSON.stringify(result);
    },
    {
      name: 'run_skill_script',
      description:
        'Run a script belonging to whichever skill is currently active, under a configurable timeout. Scoped to ' +
        "that skill's own scripts/ only — there is no way to run another skill's script with this tool. " +
        'Supports .py, .sh, and .js/.mjs/.cjs, returning stdout/stderr/exitCode.',
      schema: RunSkillScriptSchema,
    },
  );
}
