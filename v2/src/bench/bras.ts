import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { lireDemande, type Banc } from './banc.js';
import { aiguiller } from '../run/aiguillage.js';
import { COMPACTAGE, doitCompacter, type Suite } from '../run/suite.js';
import { lireFlux, type Message } from '../rapport.js';

export interface DefBras { nom: string; modele: string; brief: string; settings?: string; aiguillage?: boolean; suite?: Suite } // aiguillage : le bras de cadence run ; suite (L690) : reprend la session de l'étape d'avant // settings : réglages Claude Code du bras (hooks)
export interface Mesure { bras: string; banc: string; debut: string; fin: string; duree_s: number; releve?: Releve; // releve (L703) : ce que claude -p a rendu en dernier pour la dernière session (coût et tokens CUMULÉS depuis son début, reprises et /compact compris), repris par l'étape suivante d'un bras « suite »
  tokens: number; cout_usd: number; questions: number; questions_texte: string[]; sessions: string[]; echec: string | null; taille_declaree?: string } export type Releve = { session: string; cout: number; tokens: number };
export type Executeur = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => { stdout: string; code: number; erreur?: string; delaiMs?: number }; // delaiMs : la session a dépassé ce délai et l'exécuteur l'a arrêtée

export const OUTILS_INTERDITS = ['Bash(kubectl:*)', 'Bash(helm:*)', 'Bash(gh:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(git push:*)', 'Bash(npm publish:*)', 'Bash(raf:*)', 'Bash(cadence:*)'];
const QUESTIONS_MAX = 3;
const SANS_REPONSE = 'Pas de réponse de Sylvain : décide toi-même, note ton hypothèse dans le message de commit, et termine.';

export function chargerBras(racine: string): Record<string, DefBras> {
  const y = parse(readFileSync(join(racine, 'bras.yaml'), 'utf8')) as Record<string, { modele: string; brief: string; settings?: string; aiguillage?: boolean; suite?: Suite }>;
  return Object.fromEntries(Object.entries(y).map(([nom, d]) => [nom, { nom, modele: d.modele, brief: d.brief, ...(d.settings ? { settings: d.settings } : {}), ...(d.aiguillage ? { aiguillage: true } : {}), ...(d.suite ? { suite: d.suite } : {}) }]));
}

export const environnementNeutre = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => // L715 : la garde d'un bras (CADENCE_CLONE, _PIECES, _BANC_RACINE) est posée pour CETTE session, jamais héritée de celle qui lance le banc
  ({ ...Object.fromEntries(Object.entries(env).filter(([k]) => !/^CADENCE_(CLONE|PIECES|BANC_RACINE)$/.test(k))), KUBECONFIG: '/nonexistent', GH_TOKEN: '', GITHUB_TOKEN: '', GH_CONFIG_DIR: '/nonexistent', SSH_AUTH_SOCK: '', AETHERWX_URL: 'http://127.0.0.1:9' });

/** Lance la commande dans son propre groupe de processus et tue le groupe au retour : rien ne survit au bras suivant. L711 : l'enveloppe écrit le signal reçu sur la sortie d'erreur de l'appelant (le journal d'un run --fond, préfixe CAUSE de ../trace.ts) et s'arrête comme avant (HUP : arrêt par défaut, la commande continue), avec le code de shell du signal reçu (TERM 143, INT 130). */
export const creerExecuteur = (commande = 'claude', delaiMs = 4 * 3600_000): Executeur => (args, o) => {
  const sh = `trace() { printf "cause d'arrêt (%s) : la session claude (enveloppe pid %s, claude pid %s) a reçu %s\\n" "$(date '+%F %T')" $$ "$p" "$1" 2>/dev/null >&3; }; setsid "$0" "$@" 3>&- & p=$!; arret() { trace $1; kill -TERM -- -$p 2>/dev/null; sleep 1; kill -KILL -- -$p 2>/dev/null; exit $2; }; trap 'arret SIGTERM 143' TERM; trap 'arret SIGINT 130' INT; trap 'trace SIGHUP; trap - HUP; kill -HUP $$' HUP; wait $p; rc=$?; kill -TERM -- -$p 2>/dev/null; sleep 1; kill -KILL -- -$p 2>/dev/null; exit $rc`;
  const r = spawnSync('bash', ['-c', sh, commande, ...args], { cwd: o.cwd, env: o.env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: delaiMs, stdio: ['pipe', 'pipe', 'pipe', 2] });
  return { stdout: r.stdout ?? '', code: r.status ?? 1, erreur: r.error?.message ?? (r.signal ?? undefined), ...((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? { delaiMs } : {}) };
};
export const executeurClaude: Executeur = creerExecuteur();

/** Le tour du prompt (`travail`) décide de la session, de l'échec et du résultat ; un tour ouvert après lui (notification de tâche) n'en décide plus (issue #57).
 * Coût et jetons : ceux du dernier result, cumulés depuis le début de la session. `messages` : chaque message sans appel d'outil, avec son tour. */
export function lire(e: { stdout: string; code: number; erreur?: string }): { session: string; tokens: number; cout: number; echec: string | null; resultat: string; messages: Message[] } {
  const { travail, fin, messages, apres } = lireFlux(e.stdout);
  const arret = e.erreur ?? `code ${e.code}`;
  // Sans result : la session s'est arrêtée avant la fin de son tour (délai, signal) ; ce qu'elle a dit est dans `messages`, l'appelant le garde (issue #57).
  if (!travail || !fin) {
    const echec = messages.length ? `session arrêtée avant son result (${arret}) ; dernier message : ${messages.at(-1)!.texte.slice(-200)}` : `sortie illisible (${arret}) : ${e.stdout.slice(-200)}`;
    return { session: '', tokens: 0, cout: 0, resultat: '', messages, echec };
  }
  const tokens = Object.values(fin.modelUsage ?? {}).reduce((n, u) =>
    n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0);
  const session = travail.session_id ?? fin.session_id ?? '';
  const travailFini = !travail.is_error && (travail.subtype === undefined || travail.subtype === 'success');
  const causes: string[] = [];
  if (!session) causes.push('session_id absent');
  // Une erreur d'API dans claude -p a la forme `is_error: true, subtype: 'success'` : le détail dit « erreur » et cite le texte, jamais « success ».
  if (!travailFini) {
    const nature = travail.subtype && travail.subtype !== 'success' ? travail.subtype : 'erreur';
    causes.push(`session ${session || '?'} : ${nature}${travail.result?.trim() ? ` (« ${travail.result.trim().split('\n')[0]} »)` : ''}`);
  }
  // Le code de sortie est celui du dernier tour : il ne compte que si le travail n'a pas fini, ou si aucun tour n'a commencé après lui.
  if (e.code !== 0 && (!travailFini || !apres)) causes.push(`code ${e.code}${e.erreur ? ` (${e.erreur})` : ''}`);
  return { session, tokens, cout: fin.total_cost_usd ?? 0, resultat: travail.result ?? '', messages, echec: causes.length ? causes.join(', ') : null };
}
const HOOKS = join(import.meta.dirname, '..', '..', 'hooks');
export const cheminReglages = (clone: string) => join(`${clone}.reglages`, 'settings.json');
export const libererReglages = (clone: string) => { if (existsSync(`${clone}.reglages`)) chmodSync(`${clone}.reglages`, 0o700); }; // avant réécriture ou effacement
/** Réglages du run, à côté du clone, en lecture seule (dossier 0500, fichier 0400) ; `{{HOOKS}}` devient le chemin absolu de v2/hooks. `supplement` (L705, cadence run seul) : clés ajoutées à celles du bras ; sans lui, le fichier du bras tel quel (banc). */
export function ecrireReglages(modele: string | undefined, clone: string, supplement: Record<string, unknown> = {}): string {
  const f = cheminReglages(clone), texte = modele ? readFileSync(modele, 'utf8').replaceAll('{{HOOKS}}', JSON.stringify(HOOKS).slice(1, -1)) : '{}';
  libererReglages(clone); rmSync(dirname(f), { recursive: true, force: true }); mkdirSync(dirname(f));
  writeFileSync(f, Object.keys(supplement).length ? JSON.stringify({ ...JSON.parse(texte), ...supplement }, null, 1) : texte, { mode: 0o400 }); chmodSync(dirname(f), 0o500);
  return f;
}
/** Empreinte des réglages du run, des hooks et des réglages Claude du clone : un changement pendant l'étape est un contournement (R31). */
export const empreinteReglages = (clone: string): string => [cheminReglages(clone), ...readdirSync(HOOKS).sort().map((e) => join(HOOKS, e)),
  ...[clone, homedir()].flatMap((d) => [join(d, '.claude', 'settings.json'), join(d, '.claude', 'settings.local.json')])] // ~/.claude : lu, jamais modifié
  .reduce((h, f) => h.update(`${f}\0${existsSync(f) ? readFileSync(f, 'latin1') : 'absent'}\0`), createHash('sha1')).digest('hex');
/** Arguments communs d'une session de bras ou de `cadence run` (stream-json : chaque message final de tour, issue #57) : même modèle, mêmes interdictions, mêmes réglages (hook de lecture). `supplement` : coupes du socle de cadence run (L705, ../run/socle.ts). */
export const argsClaude = (d: DefBras, clone: string, interdits = OUTILS_INTERDITS, supplement: Record<string, unknown> = {}): string[] => ['--output-format', 'stream-json', '--verbose', '--model', d.modele, '--permission-mode', 'bypassPermissions',
  '--disallowedTools', interdits.join(','), ...(d.settings || Object.keys(supplement).length ? ['--settings', ecrireReglages(d.settings, clone, supplement)] : [])];
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
