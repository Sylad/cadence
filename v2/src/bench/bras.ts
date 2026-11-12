import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { lireDemande, type Banc } from './banc.js';
import { aiguiller } from '../run/aiguillage.js';
import { COMPACTAGE, doitCompacter, type Suite } from '../run/suite.js';

export interface DefBras { nom: string; modele: string; brief: string; settings?: string; aiguillage?: boolean; suite?: Suite } // aiguillage : le bras de cadence run ; suite (L690) : reprend la session de l'étape d'avant // settings : réglages Claude Code du bras (hooks)
export interface Mesure { bras: string; banc: string; debut: string; fin: string; duree_s: number; releve?: Releve; // releve (L703) : ce que claude -p a rendu en dernier pour la dernière session (coût et tokens CUMULÉS depuis son début, reprises et /compact compris), repris par l'étape suivante d'un bras « suite »
  tokens: number; cout_usd: number; questions: number; questions_texte: string[]; sessions: string[]; echec: string | null; taille_declaree?: string } export type Releve = { session: string; cout: number; tokens: number };
export type Executeur = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => { stdout: string; code: number; erreur?: string };

export const OUTILS_INTERDITS = ['Bash(kubectl:*)', 'Bash(helm:*)', 'Bash(gh:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(git push:*)', 'Bash(npm publish:*)', 'Bash(raf:*)', 'Bash(cadence:*)'];
const QUESTIONS_MAX = 3;
const SANS_REPONSE = 'Pas de réponse de Sylvain : décide toi-même, note ton hypothèse dans le message de commit, et termine.';

export function chargerBras(racine: string): Record<string, DefBras> {
  const y = parse(readFileSync(join(racine, 'bras.yaml'), 'utf8')) as Record<string, { modele: string; brief: string; settings?: string; aiguillage?: boolean; suite?: Suite }>;
  return Object.fromEntries(Object.entries(y).map(([nom, d]) => [nom, { nom, modele: d.modele, brief: d.brief, ...(d.settings ? { settings: d.settings } : {}), ...(d.aiguillage ? { aiguillage: true } : {}), ...(d.suite ? { suite: d.suite } : {}) }]));
}

export const environnementNeutre = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  ({ ...env, KUBECONFIG: '/nonexistent', GH_TOKEN: '', GITHUB_TOKEN: '', GH_CONFIG_DIR: '/nonexistent', SSH_AUTH_SOCK: '', AETHERWX_URL: 'http://127.0.0.1:9' });

/** Lance la commande dans son propre groupe de processus et tue le groupe au retour : rien ne survit au bras suivant. L711 : l'enveloppe écrit le signal reçu sur la sortie d'erreur de l'appelant (le journal d'un run --fond, préfixe CAUSE de ../trace.ts) et s'arrête comme avant (HUP : arrêt par défaut, la commande continue). */
export const creerExecuteur = (commande = 'claude', delaiMs = 4 * 3600_000): Executeur => (args, o) => {
  const sh = `trace() { printf "cause d'arrêt (%s) : la session claude (enveloppe pid %s, claude pid %s) a reçu %s\\n" "$(date '+%F %T')" $$ "$p" "$1" 2>/dev/null >&3; }; setsid "$0" "$@" 3>&- & p=$!; arret() { trace $1; kill -TERM -- -$p 2>/dev/null; sleep 1; kill -KILL -- -$p 2>/dev/null; exit 143; }; trap 'arret SIGTERM' TERM; trap 'arret SIGINT' INT; trap 'trace SIGHUP; trap - HUP; kill -HUP $$' HUP; wait $p; rc=$?; kill -TERM -- -$p 2>/dev/null; sleep 1; kill -KILL -- -$p 2>/dev/null; exit $rc`;
  const r = spawnSync('bash', ['-c', sh, commande, ...args], { cwd: o.cwd, env: o.env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: delaiMs, stdio: ['pipe', 'pipe', 'pipe', 2] });
  return { stdout: r.stdout ?? '', code: r.status ?? 1, erreur: r.error?.message ?? (r.signal ?? undefined) };
};
export const executeurClaude: Executeur = creerExecuteur();

export function lire(e: { stdout: string; code: number; erreur?: string }): { session: string; tokens: number; cout: number; echec: string | null; resultat: string } {
  let j: { result?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean; subtype?: string; modelUsage?: Record<string, Record<string, number>> };
  try { j = JSON.parse(e.stdout); } catch { return { session: '', tokens: 0, cout: 0, resultat: '', echec: `sortie illisible (${e.erreur ?? `code ${e.code}`}) : ${e.stdout.slice(-200)}` }; }
  const tokens = Object.values(j.modelUsage ?? {}).reduce((n, u) =>
    n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0);
  const session = j.session_id ?? '';
  const causes: string[] = [];
  if (!session) causes.push('session_id absent');
  if (j.is_error || (j.subtype !== undefined && j.subtype !== 'success')) causes.push(`session ${session || '?'} : ${j.subtype ?? 'is_error'}`);
  if (e.code !== 0) causes.push(`code ${e.code}${e.erreur ? ` (${e.erreur})` : ''}`);
  return { session, tokens, cout: j.total_cost_usd ?? 0, resultat: j.result ?? '', echec: causes.length ? causes.join(', ') : null };
}
const HOOKS = join(import.meta.dirname, '..', '..', 'hooks');
export const cheminReglages = (clone: string) => join(`${clone}.reglages`, 'settings.json');
export const libererReglages = (clone: string) => { if (existsSync(`${clone}.reglages`)) chmodSync(`${clone}.reglages`, 0o700); }; // avant réécriture ou effacement
/** Réglages du run, à côté du clone, en lecture seule (dossier 0500, fichier 0400) ; `{{HOOKS}}` devient le chemin absolu de v2/hooks. */
export function ecrireReglages(modele: string, clone: string): string {
  const f = cheminReglages(clone);
  libererReglages(clone); rmSync(dirname(f), { recursive: true, force: true }); mkdirSync(dirname(f));
  writeFileSync(f, readFileSync(modele, 'utf8').replaceAll('{{HOOKS}}', JSON.stringify(HOOKS).slice(1, -1)), { mode: 0o400 }); chmodSync(dirname(f), 0o500);
  return f;
}
/** Empreinte des réglages du run, des hooks et des réglages Claude du clone : un changement pendant l'étape est un contournement (R31). */
export const empreinteReglages = (clone: string): string => [cheminReglages(clone), ...readdirSync(HOOKS).sort().map((e) => join(HOOKS, e)),
  ...[clone, homedir()].flatMap((d) => [join(d, '.claude', 'settings.json'), join(d, '.claude', 'settings.local.json')])] // ~/.claude : lu, jamais modifié
  .reduce((h, f) => h.update(`${f}\0${existsSync(f) ? readFileSync(f, 'latin1') : 'absent'}\0`), createHash('sha1')).digest('hex');
/** Arguments communs d'une session de bras ou de `cadence run` : même modèle, mêmes interdictions, mêmes réglages (hook de lecture). */
export const argsClaude = (d: DefBras, clone: string, interdits = OUTILS_INTERDITS): string[] => ['--output-format', 'json', '--model', d.modele, '--permission-mode', 'bypassPermissions',
  '--disallowedTools', interdits.join(','), ...(d.settings ? ['--settings', ecrireReglages(d.settings, clone)] : [])];
/** `garde` : pièces à lire avant d'écrire et racine du banc, données au hook du bras par l'environnement (CADENCE_*), jamais par un fichier. */
export function lancerBras(b: Banc, d: DefBras, clone: string, exec: Executeur, horloge = () => new Date(), garde = { pieces: [] as string[], racine: '' }, reprise?: Releve): Mesure {
  if (d.aiguillage) { const a = aiguiller(lireDemande(b), clone, garde.pieces.map((p) => relative(clone, p))); d = { ...a.bras, nom: d.nom, ...(d.suite ? { suite: d.suite } : {}) }; garde = { ...garde, pieces: a.pieces.map((p) => join(clone, p)) }; }
  const question = `${clone}.question.md`;
  const brief = readFileSync(d.brief, 'utf8').replaceAll('{{DEMANDE}}', lireDemande(b)).replaceAll('{{CLONE}}', clone)
    .replaceAll('{{QUESTION}}', question).replaceAll('{{BASE}}', b.base).replaceAll('{{TAILLE}}', b.taille === 'retouche' ? 'retouche' : 'fonction'); // taille fixée par le gardien ; banc court sans retouche : fonction
  const commun = argsClaude(d, clone);
  const o = { cwd: clone, env: { ...environnementNeutre(process.env), ...(d.settings ? { CADENCE_CLONE: clone, CADENCE_PIECES: JSON.stringify(garde.pieces), CADENCE_BANC_RACINE: garde.racine } : {}) } };
  const reponse = b.reponses ? readFileSync(join(b.dir, 'reponses.md'), 'utf8') : SANS_REPONSE;
  const debut = horloge();
  const suite = d.suite ? reprise?.session : undefined, derniers = new Map<string, Releve>(suite ? [[suite, reprise!]] : []), m = { tokens: 0, cout: 0, questions: 0, textes: [] as string[], sessions: [] as string[], echec: null as string | null };
  const compter = (x: ReturnType<typeof lire>) => { const p = derniers.get(x.session), cumul = !!p && x.cout >= p.cout && x.tokens >= p.tokens; m.tokens += x.tokens - (cumul ? p!.tokens : 0); m.cout += x.cout - (cumul ? p!.cout : 0); if (x.session) derniers.set(x.session, { session: x.session, cout: x.cout, tokens: x.tokens }); return x; }; // L703 : seul l'écart au dernier relevé de la même session compte (un relevé plus bas : session repartie de zéro)
  const c = doitCompacter(d.suite, suite) ? compter(lire(exec(['-p', COMPACTAGE, '--resume', suite!, ...commun], o))) : undefined; // L690 : compactée avant le lot
  let r = compter(lire(exec(['-p', brief, ...(suite ? ['--resume', c?.session || suite] : []), ...commun], o))); m.sessions = r.session ? [r.session] : []; m.echec = c?.echec ?? r.echec;
  while (!m.echec && existsSync(question)) {
    if (m.questions >= QUESTIONS_MAX) { rmSync(question); m.echec = `question ouverte après ${QUESTIONS_MAX} réponses`; break; }
    m.textes.push(readFileSync(question, 'utf8')); rmSync(question); m.questions++;
    r = compter(lire(exec(['-p', `Réponse de Sylvain : ${reponse}`, '--resume', r.session, ...commun], o))); m.echec = r.echec;
    if (r.session && !m.sessions.includes(r.session)) m.sessions.push(r.session);
  }
  const fin = horloge();
  return { bras: d.nom, banc: b.id, debut: debut.toISOString(), fin: fin.toISOString(),
    duree_s: Math.round((fin.getTime() - debut.getTime()) / 1000), tokens: m.tokens, cout_usd: m.cout, questions: m.questions, questions_texte: m.textes, sessions: m.sessions, echec: m.echec, ...(derniers.has(m.sessions.at(-1) ?? '') ? { releve: derniers.get(m.sessions.at(-1)!) } : {}) };
}
