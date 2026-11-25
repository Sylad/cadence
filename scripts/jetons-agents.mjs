#!/usr/bin/env node
// L757 (D-4) : jetons par modèle de chaque appel d'un agent du plugin (le livreur par défaut), lus dans les transcripts de Claude Code.
//   node scripts/jetons-agents.mjs [--agent livreur] [--projects <~/.claude/projects>] [--since ISO] [--until ISO] [--dernieres N] [--json]
// Sources : transcript principal `<projects>/<dossier>/<session>.jsonl` (appel Agent ou Task : subagent_type, prompt) et transcripts de
// ses sous-agents `<projects>/<dossier>/<session>/subagents/*.jsonl` (lignes assistant : message.model, message.usage). Un sous-agent est
// relié à son appel par son premier message utilisateur, qui est le prompt de l'appel. Une réponse en plusieurs blocs répète la même
// usage sous le même message.id : elle compte une fois. La réponse rendue est le message de l'outil SubagentHandback (à défaut, le dernier texte). Mesure du lot : jetons Opus par livraison avant/après (docs/mesures/modele-agents-l757.md).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsonOu = (l) => { try { return JSON.parse(l); } catch { return null; } };
const lignesJson = (texte) => texte.split('\n').filter((l) => l.trim()).map(jsonOu).filter(Boolean);

/** Texte d'un contenu de message : chaîne, ou blocs `text` mis bout à bout. */
const texteDe = (contenu) => (typeof contenu === 'string' ? contenu
  : Array.isArray(contenu) ? contenu.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');

/** Le nom court d'un agent : `cadence:livreur` et `cadence-livreur` (installé par `cadence skills install`) donnent `livreur`. */
export const nomCourt = (type) => String(type ?? '').replace(/^.*:/, '').replace(/^cadence-/, '');

/** Jetons d'une usage : entrée, écriture et lecture de cache, sortie. */
const somme = (u) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);

/** Jetons par modèle d'un transcript, chaque message.id compté une fois. */
export function jetonsParModele(texte) {
  const vus = new Set(), par = {};
  for (const e of lignesJson(texte)) {
    const m = e.type === 'assistant' ? e.message : null;
    const id = m?.id ?? e.requestId ?? e.uuid;
    if (!m?.usage || !m.model || m.model === '<synthetic>' || (id && vus.has(id))) continue;
    vus.add(id ?? {}); // sans identifiant : jamais vu deux fois
    par[m.model] = (par[m.model] ?? 0) + somme(m.usage);
  }
  return par;
}

/** Appels d'agent d'un transcript principal : type, prompt et date. */
export function appelsAgent(texte) {
  const out = [];
  for (const e of lignesJson(texte)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && typeof b.input?.prompt === 'string') {
        out.push({ type: String(b.input.subagent_type ?? 'general-purpose'), prompt: b.input.prompt, date: e.timestamp ?? null });
      }
    }
  }
  return out;
}

/** Premier message utilisateur d'un transcript de sous-agent (le prompt de son appel). */
export function promptDe(texte) {
  for (const e of lignesJson(texte)) if (e.type === 'user' && e.message) return texteDe(e.message.content);
  return null;
}

/** Message rendu par l'outil SubagentHandback dans un contenu d'assistant (le dernier s'il y en a plusieurs), sinon null. */
const renduDe = (contenu) => (Array.isArray(contenu) ? contenu.filter((b) => b?.type === 'tool_use' && b.name === 'SubagentHandback'
  && typeof b.input?.message === 'string').map((b) => b.input.message).at(-1) ?? null : null);

/** Première ligne non vide de la réponse rendue (« L84 livré … », « Question : … ») : le message de l'outil SubagentHandback, forme
 * réelle des journaux (revue L757 r1), et seulement à défaut le dernier texte de l'assistant. */
export function reponseDe(texte) {
  let rendu = null, derniere = '';
  for (const e of lignesJson(texte)) {
    if (e.type !== 'assistant') continue;
    const r = renduDe(e.message?.content), t = texteDe(e.message?.content).trim();
    if (r !== null) rendu = r;
    if (t) derniere = t;
  }
  return (rendu ?? derniere).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/** Une livraison ratée : une question rendue au lead, ou aucune ligne « livré » / « poussé ». */
export const estRatee = (reponse) => /^question\b/i.test(reponse) || !/(?<!\p{L})(livré|poussé)(?!\p{L})/iu.test(reponse);

const opusDe = (par) => Object.entries(par).filter(([m]) => /opus/i.test(m)).reduce((n, [, v]) => n + v, 0);

const jsonls = (d) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.jsonl')) : []);
const sousDossiers = (d) => (existsSync(d) ? readdirSync(d).map((n) => join(d, n)).filter((p) => statSync(p).isDirectory()) : []);

/** L839 : appels d'outils d'un transcript (blocs tool_use des réponses, chaque id une fois), hors SubagentHandback qui rend la réponse. */
export function outilsDe(texte) {
  const ids = new Set();
  for (const e of lignesJson(texte)) {
    const blocs = e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content : [];
    for (const b of blocs) if (b?.type === 'tool_use' && b.name !== 'SubagentHandback') ids.add(b.id ?? ids.size);
  }
  return ids.size;
}

/** Une ligne de mesure pour un transcript de sous-agent relié à son appel. */
function mesure(session, appel, texte) {
  const par = jetonsParModele(texte), reponse = reponseDe(texte);
  return { session, date: appel.date, modeles: par, opus: opusDe(par), total: Object.values(par).reduce((n, v) => n + v, 0), outils: outilsDe(texte), reponse, ratee: estRatee(reponse) };
}

/** Date du premier message d'un transcript de sous-agent (null sans horodatage). */
const debutDe = (texte) => lignesJson(texte).find((e) => e.timestamp)?.timestamp ?? null;

/** Appels de l'agent dans une session : chaque sous-agent de `<session>/subagents/` relié à son appel par le prompt. Les sous-agents
 * sont pris dans l'ordre de leur premier message et chaque appel ne sert qu'une fois : deux appels au même prompt (relance après une
 * question) gardent chacun leur date. */
function appelsDeSession(dossier, fichier, agent) {
  const session = fichier.slice(0, -6), sous = join(dossier, session, 'subagents');
  const appels = existsSync(sous) ? appelsAgent(readFileSync(join(dossier, fichier), 'utf8')).filter((a) => nomCourt(a.type) === agent) : [];
  if (!appels.length) return [];
  const libres = [...appels];
  return jsonls(sous).map((s) => { const texte = readFileSync(join(sous, s), 'utf8'); return { texte, debut: debutDe(texte) }; })
    .sort((a, b) => String(a.debut ?? '').localeCompare(String(b.debut ?? '')))
    .flatMap(({ texte }) => {
      const prompt = promptDe(texte)?.trim(), i = libres.findIndex((a) => a.prompt.trim() === prompt);
      return i >= 0 ? [mesure(session, libres.splice(i, 1)[0], texte)] : [];
    });
}

/** Appels de l'agent `agent` (nom court) dans les sessions de `projects`, du plus ancien au plus récent. */
export function collecter(projects, agent = 'livreur') {
  return sousDossiers(projects).flatMap((d) => jsonls(d).flatMap((f) => appelsDeSession(d, f, agent)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

const mediane = (v) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/** Rapport texte : une ligne par appel, puis la synthèse (médiane des jetons Opus, ratées). */
export function rendre(appels, agent = 'livreur') {
  if (!appels.length) return `${agent} : aucun appel trouvé`;
  const lignes = appels.map((a) => `${String(a.date ?? '?').slice(0, 16)}  opus ${a.opus}  total ${a.total}  outils ${a.outils}  ${Object.keys(a.modeles).join(',') || '?'}  ${a.ratee ? 'RATÉE' : 'ok'}  ${a.reponse.slice(0, 80)}`);
  const ratees = appels.filter((a) => a.ratee).length;
  return [...lignes, `${agent} : ${appels.length} appel(s), jetons Opus médiane ${mediane(appels.map((a) => a.opus))}, total ${appels.reduce((n, a) => n + a.opus, 0)} ; ratées ${ratees}`].join('\n');
}

export function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const agent = opt('--agent') ?? 'livreur', n = Number(opt('--dernieres') ?? 0), since = opt('--since'), until = opt('--until');
  let appels = collecter(opt('--projects') ?? join(homedir(), '.claude', 'projects'), agent)
    .filter((a) => (!since || String(a.date) >= since) && (!until || String(a.date) < until));
  if (n > 0) appels = appels.slice(-n);
  return argv.includes('--json') ? JSON.stringify(appels, null, 2) : rendre(appels, agent);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(main(process.argv.slice(2)));
