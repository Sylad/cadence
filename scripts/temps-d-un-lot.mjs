#!/usr/bin/env node
// Étude L517 : où part le temps d'un lot. Rejoue docs/mesures/temps-d-un-lot.md sur les journaux réels.
//   node scripts/temps-d-un-lot.mjs [--runs <.cadence/runs>] [--since ISO] [--until ISO] [--transcripts <~/.claude/projects>] [--corrections <corrections.json>] [--json]
// Sources : états `<vague>/<projet>--<lot>.json` (pas, dates, jetons, estimate), `<vague>/journal.log` (attente de créneau, intégration),
// transcripts `<transcripts>/*/<sessionId>.jsonl` (outils, horodatés), et la sortie de `cadence corrections --json` pour la cause des passes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POSTES_SESSION = ['démarrage', 'lectures', 'écriture', 'tests', 'build', 'Nouveautés', 'captures', 'git', 'attente', 'autre outil', 'modèle seul'];

const RE_TESTS = /\b(vitest|jest|pytest)\b|\bnpm (run )?test\b/;
const RE_BUILD = /\btsc\b|qualite\.mjs|\bnpm run (build|lint)\b|\beslint\b|\bknip\b|\bjscpd\b|\bnpx ng build\b|\bastro build\b/;
const RE_NEWS = /\bcadence news\b|\bnews new\b|nouveautes?\/|whats-new/i;
const RE_CAPTURE = /playwright|screenshot|chrome-cdp/i;
const RE_ECRITURE = /\bsed -i\b|\bcat\s*>>?\s*\S|<<\s*['"]?\w+|\btee\b|open\([^)]*['"]w['"]|\bperl -pi\b|\bmv\b|\bcp\b|\bmkdir\b|\brm\b/;
const RE_LECTURE = /^(grep|rg|sed|cat|ls|head|tail|find|wc|awk|stat|file|jq|diff|git (log|show|diff|status|grep|ls-files|blame))\b|\|\s*(head|tail|grep|wc)\b/;

const OUTILS_FIXES = { Read: 'lectures', Grep: 'lectures', Glob: 'lectures', StructuredOutput: 'modèle seul' };
const RE_PYTHON_ECRIT = /\.write\(|\.replace\(|open\([^)]*['"][wa]['"]/;
const RE_GIT_LECTURE = /^git (log|show|diff|status|grep|ls-files|blame)\b/;
const RE_PREFIXE = /^\s*(cd\s+\S+\s*(&&|;)\s*|\w+=\S+\s*;\s*)+/;
const RE_LECTEUR = /^(grep|rg|sed|cat|ls|head|tail|find|wc|awk|stat|file|jq|diff)\b/;
const RE_CHAINE = /&&|;/;
const RE_REDIRECTION = /(^|\s)\d*>>?\s*(?!&|\/dev\/null)\S|\bsed\s+(-\w*i|--in-place)|\btee\b|-delete\b|-exec\b/;
/** Commande sans le `cd x &&` ou `VAR=v ;` qui la précède. */
const sansPrefixe = (cmd) => cmd.replace(RE_PREFIXE, '').trim();
/** Une commande de lecture seule (grep, cat…) : ses arguments citent des mots (vitest, tsc, rm) sans les exécuter. */
const estLectureSeule = (cmd) => RE_LECTEUR.test(cmd) && !RE_CHAINE.test(cmd) && !RE_REDIRECTION.test(cmd);
/** Une commande git de modification seule : ses éventuelles étapes de tests ou de build (git add … ; npx vitest run) la rangent au poste de ces étapes. */
const estGitSeul = (cmd) => {
  if (!/^git\b/.test(cmd) || RE_GIT_LECTURE.test(cmd)) return false;
  const autres = cmd.replace(/"[^"]*"|'[^']*'/g, '""').split(/&&|\|\||[;\n()]/).map((x) => x.trim()).filter((x) => x && !/^git\b/.test(sansPrefixe(x)));
  return !autres.some((x) => RE_TESTS.test(x) || RE_BUILD.test(x));
};
/** Premier motif qui reconnaît la commande : l'ordre est la priorité. */
const REGLES_BASH = [
  [{ test: estGitSeul }, 'git'],
  [{ test: estLectureSeule }, 'lectures'],
  [RE_TESTS, 'tests'],
  [RE_BUILD, 'build'],
  [RE_NEWS, 'Nouveautés'],
  [RE_CAPTURE, 'captures'],
  [/^sleep\b/, 'attente'],
  [{ test: (c) => RE_ECRITURE.test(c) || (/\bpython3?\b/.test(c) && RE_PYTHON_ECRIT.test(c)) }, 'écriture'],
  [/^(python3?|node)\b/, 'lectures'],
  [RE_LECTURE, 'lectures'],
];

/** Poste d'un outil autre que Bash : le nom suffit, sauf pour une écriture de fichier (Nouveautés si le chemin en est un). */
function posteHorsBash(nom, entree) {
  if (/playwright|browser_/i.test(nom)) return 'captures';
  if (nom in OUTILS_FIXES) return OUTILS_FIXES[nom];
  if (nom !== 'Edit' && nom !== 'Write' && nom !== 'NotebookEdit') return 'autre outil';
  return RE_NEWS.test(String(entree?.file_path ?? entree?.path ?? '')) ? 'Nouveautés' : 'écriture';
}

/**
 * Poste d'un appel d'outil. Priorité : git seul (sans étape de tests ni de build) > lecture seule > tests > build > Nouveautés > captures > attente > écriture > lectures.
 * @param {string} nom nom de l'outil (`Bash`, `Read`, `Edit`, `mcp__playwright__…`)
 * @param {Record<string, unknown>} entree entrée de l'appel
 * @returns {string} un des postes de POSTES_SESSION (hors démarrage et modèle seul)
 */
export function posteDeLOutil(nom, entree) {
  if (nom !== 'Bash' && nom !== 'bash') return posteHorsBash(nom, entree);
  const cmd = sansPrefixe(String(entree?.command ?? ''));
  return REGLES_BASH.find(([motif]) => motif.test(cmd))?.[1] ?? 'autre outil';
}

/** Une commande de tests joue la suite complète quand elle ne nomme aucun fichier ni filtre. */
export function estSuiteComplete(cmd) {
  const c = sansPrefixe(cmd);
  if (posteDeLOutil('Bash', { command: c }) !== 'tests') return false;
  return !/(\.test\.|\.spec\.|\btest\/|\bsrc\/|\s-t\s|--testNamePattern|\s-- )/.test(c);
}

const vide = () => Object.fromEntries(POSTES_SESSION.map((p) => [p, { ms: 0, n: 0, sortie: 0, contexte: 0 }]));

/**
 * Ventile une session (transcript JSONL) par poste. Un aller-retour = le temps du modèle qui précède l'appel + le temps de l'outil jusqu'à son résultat (le temps déjà couvert par un appel parallèle n'est pas compté deux fois).
 * Avant le premier appel : démarrage froid. Après le dernier résultat : « modèle seul » (rapport final). Les jetons de sortie et le contexte relu
 * (cache lu + écrit + entrée) d'un message vont au poste de son premier appel d'outil.
 * @param {string} texte contenu du fichier .jsonl
 */
export function analyserSession(texte) {
  const { debut, fin, evenements, appels, messages, resultats } = lireTranscript(texte);
  const postes = vide();
  const r = { dureeMs: 0, demarrageMs: 0, appels: appels.size, rejeuxTests: 0, rejeuxSuite: 0, suiteMs: 0, ciblesMs: 0, suiteSortie: 0, suiteContexte: 0, postes };
  if (!Number.isFinite(debut)) return r;
  let precedent = debut;
  let premier = true;
  const payes = new Set();
  for (const e of evenements) {
    if (e.genre !== 'appel') {
      precedent = Math.max(precedent, e.t);
      continue;
    }
    const a = appels.get(e.id);
    const modeleMs = Math.max(0, a.t - precedent);
    const finOutil = Math.max(a.t, resultats.get(e.id) ?? a.t);
    postes[premier ? 'démarrage' : a.poste].ms += modeleMs;
    const outilMs = Math.max(0, finOutil - Math.max(a.t, precedent));
    postes[a.poste].ms += outilMs;
    postes[a.poste].n += 1;
    premier = false;
    const msg = payes.has(a.msg) ? undefined : messages.get(a.msg);
    payes.add(a.msg);
    if (msg) {
      postes[a.poste].sortie += msg.sortie;
      postes[a.poste].contexte += msg.contexte;
    }
    if (a.poste === 'tests') compterRejeu(r, a, modeleMs + outilMs, messages.get(a.msg));
    precedent = Math.max(precedent, finOutil);
  }
  postes['modèle seul'].ms += Math.max(0, fin - precedent);
  postes['démarrage'].n = premier ? 0 : 1;
  r.dureeMs = fin - debut;
  r.demarrageMs = postes['démarrage'].ms;
  return r;
}

/** Une commande de tests de plus : suite complète (temps, jetons de sortie, contexte du message) ou test ciblé. */
function compterRejeu(r, appel, ms, message) {
  r.rejeuxTests += 1;
  if (!estSuiteComplete(appel.cmd)) {
    r.ciblesMs += ms;
    return;
  }
  r.rejeuxSuite += 1;
  r.suiteMs += ms;
  r.suiteSortie += message?.sortie ?? 0;
  r.suiteContexte += message?.contexte ?? 0;
}

/** Un nombre de jetons ou de jours : 0 quand la valeur n'en est pas un (une chaîne numérique est convertie). */
const nb = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : 0);

/** Une ligne JSONL du transcript, ou null (vide, illisible, sans date, ni assistant ni user). */
function ligneDuTranscript(ligne) {
  if (ligne.trim() === '') return null;
  let d;
  try {
    d = JSON.parse(ligne);
  } catch {
    return null;
  }
  if (d === null || typeof d !== 'object') return null;
  const t = Date.parse(d.timestamp ?? '');
  return Number.isFinite(t) && (d.type === 'assistant' || d.type === 'user') ? { d, t } : null;
}

/** Un bloc de message : un appel d'outil (assistant) ou son résultat (user, le premier seul compte). */
function noterBloc({ appels, evenements, resultats }, d, t, c) {
  if (d.type === 'assistant' && c?.type === 'tool_use' && !appels.has(c.id)) {
    appels.set(c.id, { t, poste: posteDeLOutil(c.name, c.input), cmd: String(c.input?.command ?? ''), msg: d.message.id });
    evenements.push({ t, genre: 'appel', id: c.id });
  } else if (d.type === 'user' && c?.type === 'tool_result') {
    evenements.push({ t, genre: 'resultat', id: c.tool_use_id });
    if (!resultats.has(c.tool_use_id)) resultats.set(c.tool_use_id, t);
  }
}

/** Les appels d'outil, leurs résultats et l'usage des messages d'un transcript, événements triés par date. */
function lireTranscript(texte) {
  const appels = new Map();
  const evenements = [];
  const messages = new Map();
  const resultats = new Map();
  let debut = Infinity;
  let fin = -Infinity;
  for (const ligne of texte.split('\n')) {
    const l = ligneDuTranscript(ligne);
    if (!l) continue;
    const { d, t } = l;
    debut = Math.min(debut, t);
    fin = Math.max(fin, t);
    for (const c of Array.isArray(d.message?.content) ? d.message.content : []) noterBloc({ appels, evenements, resultats }, d, t, c);
    const u = d.type === 'assistant' && d.message?.id ? d.message.usage : undefined;
    if (u) messages.set(d.message.id, { sortie: nb(u.output_tokens), contexte: nb(u.input_tokens) + nb(u.cache_read_input_tokens) + nb(u.cache_creation_input_tokens) });
  }
  evenements.sort((x, y) => x.t - y.t);
  return { debut, fin, evenements, appels, messages, resultats };
}

/** « 1 h 2 min 5 s » en millisecondes, ou null quand le texte ne contient aucune durée. */
const DUREE_MS = (s) => {
  const m = /^\s*(?:(\d+) h)?\s*(?:(\d+) min)?\s*(?:(\d+) s)?\s*$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
};

/**
 * Lit le journal d'une vague : attente de créneau obtenue et moment d'intégration, par `projet:lot`.
 * @returns {Map<string, { attentes: { t: number, ms: number }[], integre: number | null }>}
 */
export function lireJournal(texte) {
  const lots = new Map();
  const get = (k) => lots.get(k) ?? lots.set(k, { attentes: [], integre: null }).get(k);
  for (const l of texte.split(/\r?\n/)) {
    const m = /^(\S+) (\S+?:\S+?) (?:· )?(.*)$/.exec(l);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    const o = /créneau de session obtenu après (.*?) d'attente/.exec(m[3]);
    const ms = o ? DUREE_MS(o[1]) : null;
    if (ms !== null) get(m[2]).attentes.push({ t, ms });
    else if (o) continue;
    else if (/^intégré(\s|$)/.test(m[3])) get(m[2]).integre = t;
  }
  return lots;
}

/** Poste d'un pas de l'état. */
const POSTE_DU_PAS = { spec: 'préparation', fiche: 'préparation', maquette: 'préparation', precheck: 'préparation', implement: 'implémentation', probe: 'sonde', fix: 'correction', review: 'revue', 'review-small': 'revue', ux: 'ux', accept: 'acceptation' };
export const POSTES_LOT = ['préparation', 'implémentation', 'sonde', 'correction', 'revue', 'ux', 'acceptation', 'attente de créneau', 'porte et orchestration', 'intégration'];
/** Un trou de plus de 30 min entre deux pas n'est pas la porte : c'est une suspension (question au lead, budget, nuit), écartée du mur. */
export const SUSPENSION_MS = 30 * 60 * 1000;

const trouverTranscript = (racine, sessionId) => {
  if (!existsSync(racine)) return null;
  for (const d of readdirSync(racine)) {
    const f = join(racine, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
};

/**
 * Ventile un lot (état + journal de la vague + transcripts).
 * Mur d'un pas = ended − started − attente de créneau obtenue pendant le pas. Entre deux pas : porte de la vague (après une session d'écriture) ou orchestration ;
 * de la fin du dernier pas à la ligne « intégré » : intégration. Le détail d'une session d'écriture vient du transcript, s'il existe.
 */
export function ventilerLot(etat, journalLot, transcripts) {
  const r = {
    mur: Object.fromEntries(POSTES_LOT.map((p) => [p, 0])),
    jetons: Object.fromEntries(POSTES_LOT.map((p) => [p, 0])),
    suspensionMs: 0,
    session: vide(),
    rejeuxSession: 0,
    rejeuxSuiteSession: 0,
    suiteMs: 0,
    ciblesMs: 0,
    suiteSortie: 0,
    suiteContexte: 0,
    sessionsLues: 0,
    sessionsEcriture: 0,
  };
  const pas = (etat.steps ?? []).filter((s) => Number.isFinite(Date.parse(s.started)) && Date.parse(s.ended) >= Date.parse(s.started));
  const attentes = journalLot?.attentes ?? [];
  pas.forEach((s, i) => {
    const t0 = Date.parse(s.started);
    const t1 = Date.parse(s.ended);
    const poste = POSTE_DU_PAS[s.kind] ?? 'préparation';
    const attente = Math.min(t1 - t0, attentes.filter((a) => a.t >= t0 && a.t <= t1).reduce((x, a) => x + a.ms, 0));
    r.mur['attente de créneau'] += attente;
    r.mur[poste] += t1 - t0 - attente;
    r.jetons[poste] += nb(s.tokens?.counted);
    if (pas[i + 1]) ajouterTrou(r, 'porte et orchestration', Date.parse(pas[i + 1].started) - t1);
    if (s.kind === 'implement' || s.kind === 'fix') ajouterSession(r, s, transcripts, t1 - t0 - attente);
  });
  const dernier = pas.at(-1);
  if (dernier && journalLot?.integre && journalLot.integre > Date.parse(dernier.ended)) ajouterTrou(r, 'intégration', journalLot.integre - Date.parse(dernier.ended));
  const coutPasses = coutDesPasses(pas);
  return { ...r, coutPasses, passes: coutPasses.n, estimate: typeof etat.estimate === 'number' ? etat.estimate : null, lot: etat.lot, projet: etat.project, visible: etat.visible === true };
}

/** Un trou entre deux pas : au poste du lot s'il tient en 30 min, sinon suspension ; un trou négatif ou nul ne compte pas. */
function ajouterTrou(r, poste, trou) {
  if (trou <= 0) return;
  if (trou <= SUSPENSION_MS) r.mur[poste] += trou;
  else r.suspensionMs += trou;
}

/**
 * Une session d'écriture : comptée, et ventilée si son transcript est lisible. Un transcript qui déborde du pas (session reprise)
 * est ramené à `borneMs`, le mur du pas, pour que les postes de session ne dépassent pas le mur du lot.
 */
function ajouterSession(r, pas, transcripts, borneMs) {
  r.sessionsEcriture += 1;
  const f = typeof pas.sessionId === 'string' && /^[\w.-]+$/.test(pas.sessionId) ? trouverTranscript(transcripts, pas.sessionId) : null;
  if (!f) return;
  const brut = analyserSession(readFileSync(f, 'utf8'));
  const k = brut.dureeMs > borneMs ? borneMs / brut.dureeMs : 1;
  const x = { ...brut, suiteMs: brut.suiteMs * k, ciblesMs: brut.ciblesMs * k };
  x.postes = Object.fromEntries(POSTES_SESSION.map((p) => [p, { ...brut.postes[p], ms: brut.postes[p].ms * k }]));
  r.sessionsLues += 1;
  r.rejeuxSession += x.rejeuxTests;
  r.rejeuxSuiteSession += x.rejeuxSuite;
  r.suiteMs += x.suiteMs;
  r.ciblesMs += x.ciblesMs;
  r.suiteSortie += x.suiteSortie;
  r.suiteContexte += x.suiteContexte;
  for (const p of POSTES_SESSION) for (const k of ['ms', 'n', 'sortie', 'contexte']) r.session[p][k] += x.postes[p][k];
}

/** Coût des passes de correction réussies : la correction, le trou qui suit (porte) et la revue qui la suit directement. */
function coutDesPasses(pas) {
  const cout = { n: 0, ms: 0, jetons: 0 };
  pas.forEach((s, i) => {
    if (s.kind !== 'fix' || s.status !== 'ok') return;
    const apres = pas[i + 1];
    cout.n += 1;
    cout.ms += Date.parse(s.ended) - Date.parse(s.started);
    cout.jetons += nb(s.tokens?.counted);
    if (!apres) return;
    const trou = Date.parse(apres.started) - Date.parse(s.ended);
    if (trou > 0 && trou <= SUSPENSION_MS) cout.ms += trou;
    if (apres.kind === 'review' || apres.kind === 'review-small') {
      cout.ms += Date.parse(apres.ended) - Date.parse(apres.started);
      cout.jetons += nb(apres.tokens?.counted);
    }
  });
  return cout;
}

/** Vagues créées dans [since, until] (ISO), lues dans `runs`. */
export function lireVagues(runs, since, until) {
  for (const [nom, d] of [['since', since], ['until', until]]) if (d && !Number.isFinite(Date.parse(d))) throw new Error(`--${nom} : date illisible « ${d} »`);
  return readdirSync(runs).sort().flatMap((nom) => lireVague(join(runs, nom), nom, since, until));
}

/** Date de création d'une vague (`wave.json`), ou NaN si le dossier n'est pas une vague lisible. */
function creationDeLaVague(dossier) {
  try {
    return Date.parse(JSON.parse(readFileSync(join(dossier, 'wave.json'), 'utf8')).created ?? '');
  } catch {
    return Number.NaN;
  }
}

/** Les états lisibles d'une vague créée dans [since, until] ; un état illisible ou sans `steps` est écarté. */
function lireVague(dossier, nom, since, until) {
  const c = creationDeLaVague(dossier);
  if (!Number.isFinite(c) || (since && c <= Date.parse(since)) || (until && c > Date.parse(until))) return [];
  const journal = existsSync(join(dossier, 'journal.log')) ? lireJournal(readFileSync(join(dossier, 'journal.log'), 'utf8')) : new Map();
  const out = [];
  for (const f of readdirSync(dossier)) {
    if (!f.endsWith('.json') || f === 'wave.json') continue;
    try {
      const etat = JSON.parse(readFileSync(join(dossier, f), 'utf8'));
      if (Array.isArray(etat.steps)) out.push({ vague: nom, etat, journal: journal.get(`${etat.project}:${etat.lot}`) });
    } catch {
      // état illisible : écarté
    }
  }
  return out;
}

const somme = (xs) => xs.reduce((a, b) => a + b, 0);
const moyenne = (xs) => (xs.length === 0 ? 0 : somme(xs) / xs.length);
const mediane = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Tranche d'estimate (jours) d'un lot. */
export function trancheEstimate(e) {
  if (e === null) return 'sans estimate';
  if (e <= 0.1) return '≤ 0,1 j';
  if (e <= 0.5) return '0,1–0,5 j';
  if (e <= 1) return '0,5–1 j';
  return '> 1 j';
}

/**
 * Agrège les lots ventilés. Ne garde que ceux qui ont au moins une session d'écriture aboutie (un lot jamais implémenté n'a pas de temps de lot).
 */
export function agreger(lots) {
  const gardes = lots.filter((l) => l.sessionsEcriture > 0);
  const murTotal = Object.fromEntries(POSTES_LOT.map((p) => [p, somme(gardes.map((l) => l.mur[p]))]));
  const jetonsTotal = Object.fromEntries(POSTES_LOT.map((p) => [p, somme(gardes.map((l) => l.jetons[p]))]));
  const lus = gardes.filter((l) => l.sessionsLues > 0);
  const session = vide();
  for (const l of lus) for (const p of POSTES_SESSION) for (const k of ['ms', 'n', 'sortie', 'contexte']) session[p][k] += l.session[p][k];
  const tranches = {};
  for (const l of gardes) (tranches[trancheEstimate(l.estimate)] ??= []).push(l);
  return {
    lots: gardes.length,
    suspensionMin: somme(gardes.map((l) => l.suspensionMs)) / 60000,
    murTotal,
    jetonsTotal,
    session,
    lotsLus: lus.length,
    sessionsEcriture: somme(gardes.map((l) => l.sessionsEcriture)),
    sessionsLues: somme(gardes.map((l) => l.sessionsLues)),
    suite: { ms: somme(lus.map((l) => l.suiteMs)), cibleesMs: somme(lus.map((l) => l.ciblesMs)), sortie: somme(lus.map((l) => l.suiteSortie)), contexte: somme(lus.map((l) => l.suiteContexte)) },
    coutPasse: { n: somme(gardes.map((l) => l.coutPasses.n)), ms: somme(gardes.map((l) => l.coutPasses.ms)), jetons: somme(gardes.map((l) => l.coutPasses.jetons)) },
    rejeux: { session: somme(lus.map((l) => l.rejeuxSession)), suiteSession: somme(lus.map((l) => l.rejeuxSuiteSession)), moyenneSuiteParLot: moyenne(lus.map((l) => l.rejeuxSuiteSession)), medianeSuiteParLot: mediane(lus.map((l) => l.rejeuxSuiteSession)), porteVague: somme(gardes.map((l) => l.sessionsEcriture)), moyennePorteParLot: moyenne(gardes.map((l) => l.sessionsEcriture)) },
    passes: { moins1: gardes.filter((l) => l.passes === 0).length, un: gardes.filter((l) => l.passes === 1).length, deuxOuPlus: gardes.filter((l) => l.passes >= 2).length },
    parTranche: Object.fromEntries(Object.entries(tranches).map(([k, ls]) => [k, { lots: ls.length, parPosteMin: Object.fromEntries(POSTES_LOT.map((p) => [p, moyenne(ls.map((l) => l.mur[p])) / 60000])), parPosteJetons: Object.fromEntries(POSTES_LOT.map((p) => [p, moyenne(ls.map((l) => l.jetons[p]))])), murMoyenMin: moyenne(ls.map((l) => somme(Object.values(l.mur)))) / 60000, murMedianMin: mediane(ls.map((l) => somme(Object.values(l.mur)))) / 60000, jetonsMoyens: moyenne(ls.map((l) => somme(Object.values(l.jetons)))), passesMoyennes: moyenne(ls.map((l) => l.passes)), deuxOuPlus: ls.filter((l) => l.passes >= 2).length }])),
  };
}

const min = (ms) => (ms / 60000).toFixed(1).replace('.', ',');
const pct = (x, tot) => (tot === 0 ? '0 %' : `${Math.round((100 * x) / tot)} %`);
const dec = (x, n = 1) => x.toFixed(n).replace('.', ',');
const TRANCHES = ['≤ 0,1 j', '0,1–0,5 j', '0,5–1 j', '> 1 j', 'sans estimate'];
/** Une ligne par tranche d'estimate présente, dans l'ordre des tranches. */
const lignesParTranche = (a, ligne) => TRANCHES.filter((t) => a.parTranche[t]).map((t) => ligne(t, a.parTranche[t]));
const k = (n) => `${Math.round(n / 1000).toLocaleString('fr-FR')} k`;

/** Tableau des causes des passes classées par `cadence corrections`, les plus fréquentes d'abord. */
function tableCauses(byCause) {
  const tot = somme(Object.values(byCause));
  const lignes = Object.entries(byCause).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).map(([c, n]) => `| ${c} | ${n} | ${pct(n, tot)} |`);
  return ['', `Cause des ${tot} passes classées (cadence corrections) :`, '', '| Cause | Passes | Part |', '|---|---|---|', ...lignes];
}

/** Rend l'agrégat en tableaux Markdown. */
export function rendre(a, corrections) {
  const out = [];
  const murTot = somme(Object.values(a.murTotal));
  out.push(`${a.lots} lots avec une session d'écriture aboutie ; mur cumulé ${min(murTot)} min, ${k(somme(Object.values(a.jetonsTotal)))} jetons comptés (entrée, sortie, cache écrit ; hors cache lu) ; hors ${min(a.suspensionMin * 60000)} min de suspension (trous de plus de 30 min entre deux pas : question au lead, budget, nuit).`, '');
  out.push('| Poste (vue du lot) | Mur cumulé (min) | Part | Mur moyen par lot (min) | Jetons comptés | Part |', '|---|---|---|---|---|---|');
  const jTot = somme(Object.values(a.jetonsTotal));
  for (const p of POSTES_LOT) out.push(`| ${p} | ${min(a.murTotal[p])} | ${pct(a.murTotal[p], murTot)} | ${min(a.murTotal[p] / Math.max(1, a.lots))} | ${k(a.jetonsTotal[p])} | ${pct(a.jetonsTotal[p], jTot)} |`);
  const sTot = somme(POSTES_SESSION.map((p) => a.session[p].ms));
  out.push('', `Détail des sessions d'écriture (implement + fix) — ${a.sessionsLues} transcripts lus sur ${a.sessionsEcriture} sessions (${a.lotsLus} lots), ${min(sTot)} min :`, '');
  out.push('| Poste (vue de la session) | Mur (min) | Part | Appels d\'outil (démarrage : sessions) | Jetons de sortie | Contexte relu (k) |', '|---|---|---|---|---|---|');
  for (const p of POSTES_SESSION) out.push(`| ${p} | ${min(a.session[p].ms)} | ${pct(a.session[p].ms, sTot)} | ${a.session[p].n} | ${a.session[p].sortie} | ${k(a.session[p].contexte)} |`);
  const r = a.rejeux;
  out.push('', `Rejeux des tests : ${r.session} commandes de tests dans les sessions d'écriture, dont ${r.suiteSession} suites complètes (${r.moyenneSuiteParLot.toFixed(1).replace('.', ',')} par lot, médiane ${r.medianeSuiteParLot}) ; la porte de la vague rejoue la suite après chaque session d'écriture : ${r.porteVague} rejeux (${r.moyennePorteParLot.toFixed(1).replace('.', ',')} par lot).`);
  const su = a.suite;
  out.push('', `Suites complètes dans les sessions : ${min(su.ms)} min cumulées (${min(su.ms / Math.max(1, r.suiteSession))} min par rejeu, ${Math.round(su.sortie / Math.max(1, r.suiteSession))} jetons de sortie et ${k(su.contexte / Math.max(1, r.suiteSession))} de contexte relu par rejeu) contre ${min(su.cibleesMs)} min de tests ciblés.`);
  const cp = a.coutPasse;
  out.push('', `Coût d'une passe de correction (correction + porte + revue qui la suit) : ${min(cp.ms / Math.max(1, cp.n))} min et ${k(cp.jetons / Math.max(1, cp.n))} jetons comptés en moyenne sur ${cp.n} passes.`);
  out.push('', `Passes de correction par lot : 0 → ${a.passes.moins1} · 1 → ${a.passes.un} · ≥ 2 → ${a.passes.deuxOuPlus} (${pct(a.passes.deuxOuPlus, a.lots)}).`);
  out.push('', '| Estimate | Lots | Mur moyen (min) | Mur médian (min) | Jetons moyens | Passes moyennes | Lots à ≥ 2 passes |', '|---|---|---|---|---|---|---|');
  out.push(...lignesParTranche(a, (t, x) => `| ${t} | ${x.lots} | ${dec(x.murMoyenMin)} | ${dec(x.murMedianMin)} | ${k(x.jetonsMoyens)} | ${dec(x.passesMoyennes, 2)} | ${x.deuxOuPlus} |`));
  out.push('', 'Mur moyen par poste (min) selon l\'estimate :', '', `| Estimate | ${POSTES_LOT.join(' | ')} |`, `|---|${POSTES_LOT.map(() => '---').join('|')}|`);
  out.push(...lignesParTranche(a, (t, x) => `| ${t} | ${POSTES_LOT.map((p) => dec(x.parPosteMin[p])).join(' | ')} |`));
  if (corrections?.byCause) out.push(...tableCauses(corrections.byCause));
  return out.join('\n');
}

function options(argv) {
  const o = { runs: join(process.cwd(), '.cadence', 'runs'), transcripts: join(homedir(), '.claude', 'projects'), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (['--runs', '--since', '--until', '--transcripts', '--corrections'].includes(a)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} demande une valeur`);
      o[a.slice(2)] = argv[++i];
    } else throw new Error(`option inconnue : ${a}`);
  }
  return o;
}

export function main(argv) {
  const o = options(argv);
  if (!existsSync(o.runs)) throw new Error(`dossier des vagues introuvable : ${o.runs}`);
  const lots = lireVagues(o.runs, o.since, o.until).map((v) => ventilerLot(v.etat, v.journal, o.transcripts));
  const a = agreger(lots);
  const corrections = o.corrections ? JSON.parse(readFileSync(o.corrections, 'utf8')) : undefined;
  return o.json ? JSON.stringify({ ...a, lotsDetail: lots }, null, 2) : rendre(a, corrections);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
