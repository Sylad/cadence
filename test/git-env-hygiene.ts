/**
 * L677 : git exporte GIT_DIR et GIT_INDEX_FILE au hook pre-commit d'un worktree ; une suite lancée par ce hook les
 * transmettait à ses « git commit » de dépôt jetable, qui atterrissaient alors dans le vrai dépôt.
 */
export const GIT_REPO_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;

export function stripGitRepoVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const n of GIT_REPO_VARS) delete out[n];
  return out;
}
