// Builds the Artifact Index (GLOSSARY.md § Skill Invocation & Runtime
// Access) appended to a skill's expanded body on every invocation —
// computed fresh from disk, never authored into SKILL.md (ADR-0022), so it
// can never go stale relative to what's actually in scripts//references/.
//
// References before scripts, alphabetically sorted within each group — pure
// ordering choice for determinism (reproducible eval-scenario text, stable
// test assertions), not specified by the design itself.
export function buildArtifactIndex(
  scripts: Record<string, string>,
  references: Record<string, string>,
): string {
  const referenceNames = Object.keys(references).sort();
  const scriptNames = Object.keys(scripts).sort();
  if (referenceNames.length === 0 && scriptNames.length === 0) return '';

  const lines = [
    ...referenceNames.map(
      (name) => `- Reference \`${name}\` → call \`read_skill_reference\` with \`name: "${name}"\``,
    ),
    ...scriptNames.map(
      (name) => `- Script \`${name}\` → call \`run_skill_script\` with \`name: "${name}"\``,
    ),
  ];

  return ['## Available Artifacts', ...lines].join('\n');
}
