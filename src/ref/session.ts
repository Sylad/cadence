import { randomUUID } from 'node:crypto';
import { readOrchestrateConfig } from '../config.js';
import { enabledPlugins, journalTokens, runSession, settingsFiles, type AgentDef, type ClaudeFn, type Model } from '../orchestrate/launch.js';
import { sumTokens } from '../orchestrate/result.js';
import { RafError } from '../plan.js';

export interface SessionRef {
  /** Agent du paquet (`reference-analyst`, `reference-verifier`). */
  agent: string;
  brief: string;
  model: Model;
  schema: object;
  slug: string;
  /** Le dossier du document : répertoire de travail et seul dossier ajouté à la session. */
  docDir: string;
  configPath: string;
  /** Dossier de Claude Code : le journal d'une session coupée y est relu pour compter ses jetons. */
  claudeHome: string;
  claude: ClaudeFn;
  agents: Record<string, AgentDef>;
  /** Ce que la session coupée a laissé à moitié écrit, effacé avant la session neuve. */
  onRelaunch?: () => void;
  /** Dit ce que la session faisait quand elle échoue : « la session de lecture a échoué : <cause> ». */
  echec: string;
}

type ResultatSession = { kind: 'ok'; structured: unknown; tokens: number; session: string } | { kind: 'quota'; message: string };

/**
 * Une session de la chaîne `ref` hors vague (mêmes sortie JSON, schéma, relance de mise en forme et relance d'une session coupée qu'orchestrate),
 * avec les jetons comptés comme le budget d'orchestrate : ceux de la session coupée (son journal) s'ajoutent à ceux de la relance.
 * Un échec est une `RafError` (code 2), un quota un résultat.
 */
export async function sessionDeRef(o: SessionRef): Promise<ResultatSession> {
  const config = readOrchestrateConfig(o.configPath);
  const outcome = await runSession(
    {
      kind: 'ref',
      sessionId: randomUUID(),
      brief: o.brief,
      model: o.model,
      effort: config.effort.review,
      schema: o.schema,
      agent: o.agent,
      cwd: o.docDir,
      wave: `ref-${o.slug}`,
      permissionMode: config.permissionMode,
      addDirs: [o.docDir],
      timeoutMs: config.timeouts.work,
      disablePlugins: enabledPlugins(settingsFiles(o.claudeHome, o.docDir)), // comme une étape de vague (L398)
    },
    { claude: o.claude, agents: o.agents, onRelaunch: o.onRelaunch },
  );
  if (outcome.kind === 'quota') return { kind: 'quota', message: outcome.message };
  if (outcome.kind === 'failed') throw new RafError(`ref analyse : ${o.echec} : ${outcome.cause}`);
  const cut = outcome.relaunched ? journalTokens(o.claudeHome, o.docDir, outcome.relaunched.sessionId) : null;
  const tokens = cut ? sumTokens(cut.tokens, outcome.result.tokens).counted : outcome.result.tokens.counted;
  return { kind: 'ok', structured: outcome.result.structured, tokens, session: outcome.result.sessionId };
}
