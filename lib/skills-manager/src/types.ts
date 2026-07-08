export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string; // parsed and stored as-is; enforcement deferred until tools-manager is built
}

export interface Skill {
  name: string;
  slashCommand: string;
  enabled: boolean;
  path: string;
  frontmatter: SkillFrontmatter;
  body: string;
  scripts: Record<string, string>;    // basename → absolute filepath; use readFile() for content
  references: Record<string, string>; // basename → absolute filepath; use readFile() for content
}

export interface SkillSummary {
  name: string;
  description: string;
  slashCommand: string;
  enabled: boolean;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface EditSkillInput {
  description?: string;
  body?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  enabled?: boolean;
}

export interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
