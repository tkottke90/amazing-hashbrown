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
  largeDesc: boolean; // true when description.length > DESCRIPTION_MAX (1024)
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

// ── Output quality eval types ──────────────────────────────────────────

export interface EvalCase {
  id: number | string;
  prompt: string;
  expected_output: string;
  files?: string[];       // relative paths to input files (under evals/files/)
  assertions?: string[];  // verifiable statements about expected output
}

export interface EvalSuite {
  skill_name: string;
  evals: EvalCase[];
}

export interface AssertionResult {
  text: string;
  passed: boolean;
  evidence: string; // quote or reference to output; required even for PASS
}

export interface GradingResult {
  assertion_results: AssertionResult[];
  summary: {
    passed: number;
    failed: number;
    total: number;
    pass_rate: number; // passed / total
  };
}

export interface TimingData {
  total_tokens: number;
  duration_ms: number;
}

export interface RunStats {
  pass_rate: { mean: number; stddev: number };
  time_seconds: { mean: number; stddev: number };
  tokens: { mean: number; stddev: number };
}

export interface BenchmarkResult {
  run_summary: {
    with_skill: RunStats;
    without_skill: RunStats;
    delta: {
      pass_rate: number;
      time_seconds: number;
      tokens: number;
    };
  };
}

// ── Description trigger eval types ────────────────────────────────────

export interface EvalQuery {
  query: string;
  should_trigger: boolean;
}

export interface EvalQuerySplit {
  train: EvalQuery[];
  validation: EvalQuery[];
}
