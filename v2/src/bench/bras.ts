import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { lireDemande, type Banc } from './banc.js';

export interface DefBras { nom: string; modele: string; brief: string }
export interface Mesure { bras: string; banc: string; debut: string; fin: string; duree_s: number;
  tokens: number; cout_usd: number; questions: number; questions_texte: string[]; sessions: string[]; echec: string | null }
export type Executeur = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => { stdout: string; code: number; erreur?: string };

export const OUTILS_INTERDITS = ['Bash(kubectl:*)', 'Bash(helm:*)', 'Bash(gh:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(git push:*)', 'Bash(npm publish:*)', 'Bash(raf:*)', 'Bash(cadence:*)'];
const QUESTIONS_MAX = 3;
const SANS_REPONSE = 'Pas de réponse de Sylvain : décide toi-même, note ton hypothèse dans le message de commit, et termine.';

export function chargerBras(racine: string): Record<string, DefBras> {
  const y = parse(readFileSync(join(racine, 'bras.yaml'), 'utf8')) as Record<string, { modele: string; brief: string }>;
  return Object.fromEntries(Object.entries(y).map(([nom, d]) => [nom, { nom, modele: d.modele, brief: d.brief }]));
}

export const environnementNeutre = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  ({ ...env, KUBECONFIG: '/nonexistent', GH_TOKEN: '', GITHUB_TOKEN: '', GH_CONFIG_DIR: '/nonexistent', SSH_AUTH_SOCK: '', AETHERWX_URL: 'http://127.0.0.1:9' });

/** Lance la commande dans son propre groupe de processus et tue le groupe au retour : rien ne survit au bras suivant. */
export const creerExecuteur = (commande = 'claude', delaiMs = 4 * 3600_000): Executeur => (args, o) => {
  const sh = 'setsid "$0" "$@" & p=$!; trap \'kill -TERM -- -$p 2>/dev/null; sleep 1; kill -KILL -- -$p 2>/dev/null; exit 143\' TERM INT; wait $p; rc=$?; kill -TERM -- -$p 2>/dev/null; sleep 1; kill -KILL -- -$p 2>/dev/null; exit $rc';
  const r = spawnSync('bash', ['-c', sh, commande, ...args], { cwd: o.cwd, env: o.env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: delaiMs });
  return { stdout: r.stdout ?? '', code: r.status ?? 1, erreur: r.error?.message ?? (r.signal ?? undefined) };
};
export const executeurClaude: Executeur = creerExecuteur();

function lire(e: { stdout: string; code: number; erreur?: string }): { session: string; tokens: number; cout: number; echec: string | null } {
  let j: { session_id?: string; total_cost_usd?: number; is_error?: boolean; subtype?: string; modelUsage?: Record<string, Record<string, number>> };
  try {
    j = JSON.parse(e.stdout);
  } catch {
    return { session: '', tokens: 0, cout: 0, echec: `sortie illisible (${e.erreur ?? `code ${e.code}`}) : ${e.stdout.slice(-200)}` };
  }
  const tokens = Object.values(j.modelUsage ?? {}).reduce((n, u) =>
    n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0);
  const session = j.session_id ?? '';
  const causes: string[] = [];
  if (!session) causes.push('session_id absent');
  if (j.is_error || (j.subtype !== undefined && j.subtype !== 'success')) causes.push(`session ${session || '?'} : ${j.subtype ?? 'is_error'}`);
  if (e.code !== 0) causes.push(`code ${e.code}${e.erreur ? ` (${e.erreur})` : ''}`);
  return { session, tokens, cout: j.total_cost_usd ?? 0, echec: causes.length ? causes.join(', ') : null };
}

export function lancerBras(b: Banc, d: DefBras, clone: string, exec: Executeur, horloge = () => new Date()): Mesure {
  const question = `${clone}.question.md`;
  const brief = readFileSync(d.brief, 'utf8').replaceAll('{{DEMANDE}}', lireDemande(b)).replaceAll('{{CLONE}}', clone)
    .replaceAll('{{QUESTION}}', question).replaceAll('{{BASE}}', b.base);
  const commun = ['--output-format', 'json', '--model', d.modele, '--permission-mode', 'bypassPermissions',
    '--disallowedTools', OUTILS_INTERDITS.join(',')];
  const o = { cwd: clone, env: environnementNeutre(process.env) };
  const reponse = b.reponses ? readFileSync(join(b.dir, 'reponses.md'), 'utf8') : SANS_REPONSE;
  const debut = horloge();
  let r = lire(exec(['-p', brief, ...commun], o));
  const m = { tokens: r.tokens, cout: r.cout, questions: 0, textes: [] as string[], sessions: r.session ? [r.session] : [], echec: r.echec };
  while (!m.echec && existsSync(question)) {
    if (m.questions >= QUESTIONS_MAX) { rmSync(question); m.echec = `question ouverte après ${QUESTIONS_MAX} réponses`; break; }
    m.textes.push(readFileSync(question, 'utf8')); rmSync(question); m.questions++;
    r = lire(exec(['-p', `Réponse de Sylvain : ${reponse}`, '--resume', r.session, ...commun], o));
    m.tokens += r.tokens; m.cout += r.cout; m.echec = r.echec;
    if (r.session && !m.sessions.includes(r.session)) m.sessions.push(r.session);
  }
  const fin = horloge();
  return { bras: d.nom, banc: b.id, debut: debut.toISOString(), fin: fin.toISOString(),
    duree_s: Math.round((fin.getTime() - debut.getTime()) / 1000), tokens: m.tokens, cout_usd: m.cout, questions: m.questions, questions_texte: m.textes, sessions: m.sessions, echec: m.echec };
}
