import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/*
 * L742 (D-23 B) : ce qui change le coût ou le comportement d'un bras sans changer l'empreinte de v2. Le 16-11, Claude Code est passé de 2.1.293
 * à 2.1.325 sur Big-Blue, et l'alias fable désigne Fable 5.2 depuis le 09-11 : aucun rapport ne le voyait. Chaque rapport note donc la version
 * de Claude Code, l'identifiant exact du modèle de chaque bras (lu dans le flux de ses sessions, jamais l'alias de bras.yaml) et les réglages
 * suivis ; un rapport dont ces champs diffèrent de ceux du passage précédent le dit en tête, et `bench comparer` le dit pour deux rapports.
 */

/** Ce que les sessions d'un bras ont dit d'elles-mêmes (system/init et modelUsage de chaque result) et les réglages qu'elles ont reçus. */
export interface ClaudeBras { versions: string[]; modeles: string[]; autres_modeles: string[]; contexte_max: Record<string, number>; reglages: Record<string, string> }
/** L'environnement d'un passage : `claude --version` au lancement, et pour chaque bras son alias de bras.yaml et ce que ses sessions ont dit. */
export interface Environnement { claude_code: string; bras: Record<string, ClaudeBras & { alias: string }> }

/** Variables d'environnement qui changent le coût ou le comportement d'une session (liste fermée : les autres CLAUDE_* sont des identifiants
 * de session, de compte ou de socket, qui changeraient à chaque passage). Les clés et jetons n'y sont jamais. */
const SUIVIES = /^(CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_EFFORT|CLAUDE_CODE_DISABLE_\w+|CLAUDE_CODE_MAX_OUTPUT_TOKENS|CLAUDE_CODE_AUTO_COMPACT_WINDOW|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_EXPERIMENTAL_\w+|CLAUDE_CODE_SIMPLE|CLAUDE_CONFIG_DIR|MAX_THINKING_TOKENS|DISABLE_\w+|ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_BASE_URL)$/;
/** Clés des fichiers de réglages qui changent le coût ou le comportement (plus leur bloc `env`, filtré par SUIVIES). */
const CLES = ['effortLevel', 'model', 'fastMode', 'alwaysThinkingEnabled'];
/** Toujours écrits, même absents, pour que l'absence se lise (demande de Sylvain du 16-11). */
const ATTENDUES = ['CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES'];

/** `claude --version` (« 2.1.325 (Claude Code) » donne 2.1.325) ; « inconnue » si claude ne répond pas. */
export function versionClaude(commande = 'claude'): string {
  try { return execFileSync(commande, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim().split(/\s/)[0] || 'inconnue'; } catch { return 'inconnue'; }
}

/** Les réglages suivis d'une session : son environnement, les réglages utilisateur (CLAUDE_CONFIG_DIR ou ~/.claude) et le fichier de réglages du bras. */
export function reglagesClaude(env: NodeJS.ProcessEnv, reglagesBras?: string): Record<string, string> {
  const r: Record<string, string> = {};
  const variables = (source: string, e: Record<string, unknown>) => { for (const [k, v] of Object.entries(e)) if (SUIVIES.test(k) && v !== undefined) r[`${source}${k}`] = String(v); };
  variables('env ', env);
  const dossier = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude');
  for (const [source, f] of [['réglages utilisateur', join(dossier, 'settings.json')], ...(reglagesBras ? [[`réglages du bras ${basename(reglagesBras)}`, reglagesBras]] : [])]) {
    let j: Record<string, unknown>;
    try { j = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; } catch { r[source] = `illisible (${f})`; continue; }
    for (const k of CLES) if (j[k] !== undefined) r[`${source} ${k}`] = typeof j[k] === 'string' ? j[k] as string : JSON.stringify(j[k]);
    if (j.env && typeof j.env === 'object') variables(`${source} env `, j.env as Record<string, unknown>);
  }
  if (!Object.keys(r).some((k) => /EFFORT|effortLevel/.test(k))) r.effort = 'non réglé (défaut de Claude Code)';
  for (const v of ATTENDUES) if (!Object.keys(r).some((k) => k.endsWith(v))) r[`env ${v}`] = 'non posée';
  return r;
}

const ajouter = (l: string[], x: unknown) => { if (typeof x === 'string' && x && !l.includes(x)) l.push(x); };

/** Ajoute à `c` ce qu'une session a écrit dans son flux stream-json : version et modèle (system/init), modèles facturés et contexte max (modelUsage). */
export function ajouterSession(c: ClaudeBras, stdout: string): ClaudeBras {
  for (const l of stdout.split('\n')) {
    let e: { type?: string; subtype?: string; model?: unknown; claude_code_version?: unknown; modelUsage?: Record<string, { contextWindow?: unknown }> };
    try { e = JSON.parse(l); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'system' && e.subtype === 'init') { ajouter(c.versions, e.claude_code_version); ajouter(c.modeles, e.model); }
    for (const [m, u] of Object.entries(e.modelUsage ?? {})) { if (typeof u?.contextWindow === 'number') c.contexte_max[m] = u.contextWindow; if (!c.modeles.includes(m)) ajouter(c.autres_modeles, m); }
  }
  c.autres_modeles = c.autres_modeles.filter((m) => !c.modeles.includes(m)); // un init lu après le result de la même session
  return c;
}

export const claudeVide = (reglages: Record<string, string> = {}): ClaudeBras => ({ versions: [], modeles: [], autres_modeles: [], contexte_max: {}, reglages });

/** L'environnement d'un passage, à partir des mesures de chaque bras (tous bancs, répétitions et étapes). */
export function environnement(claude_code: string, alias: Record<string, string>, mesures: { bras: string; claude?: ClaudeBras }[]): Environnement {
  const bras: Environnement['bras'] = {};
  for (const m of mesures) {
    const b = bras[m.bras] ??= { alias: alias[m.bras] ?? '?', ...claudeVide() };
    if (!m.claude) continue;
    for (const k of ['versions', 'modeles', 'autres_modeles'] as const) for (const x of m.claude[k]) ajouter(b[k], x);
    Object.assign(b.contexte_max, m.claude.contexte_max); Object.assign(b.reglages, m.claude.reglages);
  }
  return { claude_code, bras };
}

const liste = (l: string[]) => (l.length ? l.join(', ') : 'non lu (aucune session n\'a démarré)');
const nombre = (n: number) => n.toLocaleString('fr-FR').replace(/\s/g, ' ');

/** Les différences de b par rapport à a : version, modèle exact de chaque alias, puis, bras par bras, autres modèles, contexte max et réglages. */
export function ecartsEnvironnement(a: Environnement, b: Environnement): string[] {
  const d: string[] = [];
  const diff = (nom: string, x: string, y: string) => { if (x !== y) d.push(`${nom} : ${x} → ${y}`); };
  diff('Claude Code', a.claude_code, b.claude_code);
  const parAlias = (e: Environnement) => Object.values(e.bras).reduce<Record<string, string[]>>((m, x) => { for (const id of x.modeles) ajouter(m[x.alias] ??= [], id); return m; }, {});
  const ma = parAlias(a), mb = parAlias(b);
  for (const al of Object.keys(mb).filter((k) => ma[k])) diff(`alias ${al}`, ma[al].sort().join(', '), mb[al].sort().join(', '));
  for (const n of Object.keys(b.bras).filter((k) => a.bras[k])) {
    const x = a.bras[n], y = b.bras[n];
    if (x.modeles.length && y.modeles.length) diff(`autres modèles de ${n}`, x.autres_modeles.join(', ') || 'aucun', y.autres_modeles.join(', ') || 'aucun');
    for (const m of Object.keys(y.contexte_max).filter((k) => x.contexte_max[k] !== undefined)) diff(`contexte max de ${m} (${n})`, nombre(x.contexte_max[m]), nombre(y.contexte_max[m]));
    for (const k of [...new Set([...Object.keys(x.reglages), ...Object.keys(y.reglages)])].sort()) diff(`${k} (${n})`, x.reglages[k] ?? 'absent', y.reglages[k] ?? 'absent');
  }
  return d;
}

/** Le passage précédent dans `rapports/` (nom avant `courant`, ordre des noms = ordre du temps), avec son environnement s'il en a un. */
export function passagePrecedent(racine: string, courant: string): { run: string; environnement?: Environnement } | null {
  const d = join(racine, 'rapports');
  const avant = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json') && f.slice(0, -5) < courant).sort() : [];
  if (!avant.length) return null;
  const f = avant.at(-1)!;
  try { return { run: f.slice(0, -5), environnement: (JSON.parse(readFileSync(join(d, f), 'utf8')) as { environnement?: Environnement }).environnement }; } catch { return { run: f.slice(0, -5) }; }
}

/** La ligne de comparaison : ⚠ et les différences, « identique », ou l'impossibilité de comparer. */
export function ligneComparaison(run: string, avant: Environnement | undefined, apres: Environnement): string {
  if (!avant) return `Environnement non comparable à ${run} : ce rapport ne le note pas (rapport d'avant L742)`;
  const d = ecartsEnvironnement(avant, apres);
  return d.length ? `⚠ Environnement différent de ${run} : ${d.join(' ; ')}` : `Environnement identique à ${run}`;
}

/** Lignes d'en-tête d'un rapport : comparaison au passage précédent (d'abord, pour qu'elle se lise en tête), version, modèle et réglages de chaque bras. */
export function enteteEnvironnement(e: Environnement, precedent: { run: string; environnement?: Environnement } | null): string[] {
  const bras = Object.entries(e.bras);
  const ctx = (x: ClaudeBras) => Object.entries(x.contexte_max).map(([m, n]) => `${m} ${nombre(n)}`).join(', ');
  const reglages = (x: ClaudeBras) => Object.entries(x.reglages).map(([k, v]) => `${k} = ${v}`).join(' ; ') || 'aucun';
  const memes = bras.length > 1 && bras.every(([, x]) => reglages(x) === reglages(bras[0][1]));
  const versionsSessions = [...new Set(bras.flatMap(([, x]) => x.versions))];
  return [
    ...(precedent ? [ligneComparaison(precedent.run, precedent.environnement, e)] : ['Environnement : premier rapport de cette racine, rien à comparer']),
    `Claude Code : ${e.claude_code} (claude --version au lancement)${versionsSessions.length && versionsSessions.join(', ') !== e.claude_code ? ` ; sessions : ${versionsSessions.join(', ')}` : ''}`,
    ...bras.map(([n, x]) => `Bras ${n} : alias ${x.alias} → ${liste(x.modeles)}${x.autres_modeles.length ? ` ; autres modèles facturés : ${x.autres_modeles.join(', ')}` : ''}${ctx(x) ? ` ; contexte max : ${ctx(x)}` : ''}`),
    ...(memes ? [`Réglages (les deux bras) : ${reglages(bras[0][1])}`] : bras.map(([n, x]) => `Réglages de ${n} : ${reglages(x)}`)),
  ];
}
