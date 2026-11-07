import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { lireDemande, type Banc } from './banc.js';

export interface DefBras { nom: string; modele: string; brief: string }
export interface Mesure { bras: string; banc: string; debut: string; fin: string; duree_s: number;
  tokens: number; cout_usd: number; questions: number; sessions: string[] }
export type Executeur = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => { stdout: string; code: number };

export const OUTILS_INTERDITS = ['Bash(kubectl:*)', 'Bash(helm:*)', 'Bash(gh:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(git push:*)', 'Bash(npm publish:*)', 'Bash(raf:*)', 'Bash(cadence:*)'];
const QUESTIONS_MAX = 3;
const SANS_REPONSE = 'Pas de réponse de Sylvain : décide toi-même, note ton hypothèse dans le message de commit, et termine.';

export function chargerBras(racine: string): Record<string, DefBras> {
  const y = parse(readFileSync(join(racine, 'bras.yaml'), 'utf8')) as Record<string, { modele: string; brief: string }>;
  return Object.fromEntries(Object.entries(y).map(([nom, d]) => [nom, { nom, modele: d.modele, brief: d.brief }]));
}

export const environnementNeutre = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  ({ ...env, KUBECONFIG: '/nonexistent', GH_TOKEN: '', GITHUB_TOKEN: '', AETHERWX_URL: 'http://127.0.0.1:9' });

export const executeurClaude: Executeur = (args, o) => {
  const r = spawnSync('claude', args, { cwd: o.cwd, env: o.env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: 4 * 3600_000 });
  return { stdout: r.stdout ?? '', code: r.status ?? 1 };
};

function lire(stdout: string): { session: string; tokens: number; cout: number } {
  try {
    const j = JSON.parse(stdout) as { session_id: string; total_cost_usd: number; modelUsage: Record<string, Record<string, number>> };
    const tokens = Object.values(j.modelUsage ?? {}).reduce((n, u) =>
      n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0);
    return { session: j.session_id, tokens, cout: j.total_cost_usd ?? 0 };
  } catch {
    throw new Error(`sortie de claude illisible : ${stdout.slice(-400)}`);
  }
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
  let r = lire(exec(['-p', brief, ...commun], o).stdout);
  const m = { tokens: r.tokens, cout: r.cout, questions: 0, sessions: [r.session] };
  while (existsSync(question) && m.questions < QUESTIONS_MAX) {
    rmSync(question); m.questions++;
    r = lire(exec(['-p', `Réponse de Sylvain : ${reponse}`, '--resume', r.session, ...commun], o).stdout);
    m.tokens += r.tokens; m.cout += r.cout;
    if (!m.sessions.includes(r.session)) m.sessions.push(r.session);
  }
  const fin = horloge();
  return { bras: d.nom, banc: b.id, debut: debut.toISOString(), fin: fin.toISOString(),
    duree_s: Math.round((fin.getTime() - debut.getTime()) / 1000), tokens: m.tokens, cout_usd: m.cout, questions: m.questions, sessions: m.sessions };
}
