# .hashbrown/ gets its own .gitignore entry at workspace provision time

Nothing today keeps `.hashbrown/summaries/*.md` out of a workspace's own git-backed repo when that workspace has one — the files can end up untracked and stageable in a user's real project. Adding Task Files doubles the generated-file footprint in that same directory, so workspace provisioning now writes (or ensures) a `.gitignore` entry for `.hashbrown/` in the workspace's working tree, covering both `summaries/` and `tasks/` as a single mechanical fix rather than leaving it to the user's own git hygiene.
