// L715 : variables qu'une session de cadence pose pour ELLE-MÊME (vague, cadence run, porte, livraison, fumée, commit d'un programme).
// Une suite lancée depuis une telle session en hérite ; aucun test ne les reçoit de l'appelant : celui qui en lit une la pose lui-même (vi.stubEnv).
// Jamais les réglages de la suite (CADENCE_PLAYWRIGHT de la CI, CADENCE_TEST_*) : ils doivent arriver aux tests.
export const VARIABLES_SESSION = [
  // vague (src/orchestrate : launch.ts, snapshot.ts, proc.ts)
  'CADENCE_ORCHESTRATED', 'CADENCE_SESSION', 'CADENCE_SNAPSHOT', 'CADENCE_WAVE_RESERVED',
  // cadence run et banc (v2/src/run/run.ts, v2/src/run/cli.ts, v2/src/bench/bras.ts)
  'CADENCE_CLONE', 'CADENCE_PIECES', 'CADENCE_BANC_RACINE', 'CADENCE_RUN_JOURNAL',
  // porte, livraison et acceptation (src/verify.ts, src/deliver.ts, src/orchestrate/accept.ts)
  'CADENCE_SHA', 'CADENCE_SHORT', 'CADENCE_BRANCH', 'CADENCE_DEPLOYED_FILE', 'CADENCE_ACCEPTATION', 'CADENCE_ACCEPTATION_ROOT',
  // session-start, fumée de release, commit d'un programme (src/session.ts, src/release-fumee.ts, src/git.ts)
  'CADENCE_SINCE', 'CADENCE_TODAY', 'CADENCE_FUMEE_PAQUET', 'CADENCE_FUMEE_RACINE', 'CADENCE_COMMIT_PROGRAMME',
] as const;

export function retirerVariablesSession(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of VARIABLES_SESSION) delete env[k];
}
