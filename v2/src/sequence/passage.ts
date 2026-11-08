import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Banc } from '../bench/banc.js';
import { chargerBras, cheminReglages, ecrireReglages, empreinteReglages, lancerBras, libererReglages, type DefBras, type Executeur, type Mesure } from '../bench/bras.js';
import { archiver, pretAPasser, verrouiller } from '../bench/cli.js';
import { chercherFuites, dossierTranscripts, jsonl, reglesDuBras, type Regles } from '../bench/fuites.js';
import { etatGit, juger, travailNonLivre, type Jugement } from '../bench/juges.js';
import { preparer, shell } from '../bench/preparer.js';
import { parisJour } from '../bench/verdict.js';
import { jouerTests, lectureReferences, maintenabilite } from './mesures.js';
import { chargerSequence, type Etape, type Sequence } from './sequence.js';

type Statuts = Record<string, boolean>;
/** Tests verts à l'étape d'avant : rouges maintenant, ou disparus (absents, ignorés, supprimés). */
export interface Ecart { rouges: string[]; disparus: string[] }
/** Ce que le diff de l'étape a retiré aux tests, en ids « fichier > titre » (titre seul, sans les describe) : ils ne se joignent PAS aux ids de la suite, le rapport les montre à part. */
export interface Affaiblis { fichiers_supprimes: string[]; tests_retires: string[]; skip_only: string[] }
export interface MesureEtape {
  /** `reponses` : l'étape a un reponses.md (une question y est utile) ; sans lui, toute question du candidat est inutile. */
  k: number; portee_suite: string; reponses?: boolean; mesure: Mesure; fuites: string[]; fuites_a_verifier: string[];
  lecture?: ReturnType<typeof lectureReferences>; suite?: { passes: number; total: number }; suite_en_erreur: string | null;
  regressions?: Ecart; nouveaux?: string[]; tests_affaiblis?: Affaiblis; build_ok?: boolean; maintenabilite?: ReturnType<typeof maintenabilite>;
  mesure_en_erreur: string | null;
}
/** Étape 0 : la pente de maintenabilité se mesure depuis ici. */
export interface Base { suite: { passes: number; total: number }; build_ok: boolean; maintenabilite: ReturnType<typeof maintenabilite> }
export interface ResultatSequence { run: string; sequence: string; clones: Record<string, string>; base: Record<string, Base>; etapes: Record<string, MesureEtape[]>; jugement: Jugement | null }
type Opt = { racine: string; id: string; ref: string; cand: string; juge: string; exec: Executeur; maintenant: Date; empreinte: string; home: string; out: (l: string) => void;
  prep?: typeof preparer; pret?: (b: Record<string, DefBras>) => string | null; jscpd?: string[]; delaiMs?: number; garderClones?: boolean; tirage?: () => number };
interface Ctx { o: Opt; s: Sequence; bras: Record<string, DefBras>; run: string; dir: string; debut: string; delai: number;
  noms: string[]; clones: Record<string, string>; prec: Record<string, Statuts> }

const REPO = join(import.meta.dirname, '..', '..', '..');
const TITRE = /\b(?:it|test)(\.\w+)?\s*\(\s*(['"`])(.*?)\2/;

export function ecart(avant: Statuts, apres: Statuts): Ecart & { nouveaux: string[] } {
  const verts = Object.keys(avant).filter((k) => avant[k]);
  return {
    rouges: verts.filter((k) => apres[k] === false),
    disparus: verts.filter((k) => !(k in apres)),
    nouveaux: Object.keys(apres).filter((k) => !(k in avant)),
  };
}

/** Diff de `avant` à la copie de travail, fichiers *.spec.* et *.test.* : fichiers supprimés, titres retirés, `.skip`/`.only` ajoutés. */
export function testsAffaiblis(clone: string, avant: string): Affaiblis {
  const diff = execFileSync('git', ['diff', avant, '--', ':(glob)**/*.spec.*', ':(glob)**/*.test.*'],
    { cwd: clone, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
  const vus: { id: string; signe: string; skip: boolean }[] = [];
  const supprimes: string[] = [];
  let fichier = '';
  for (const l of diff) {
    if (l.startsWith('--- a/') || l.startsWith('+++ b/')) fichier = l.slice(6);
    else if (l === '+++ /dev/null') supprimes.push(fichier);
    else if (/^[-+](?![-+]{2} )/.test(l)) {
      const m = TITRE.exec(l);
      if (m) vus.push({ id: `${fichier} > ${m[3]}`, signe: l[0], skip: m[1] === '.skip' || m[1] === '.only' });
    }
  }
  const ids = (signe: string, skip?: boolean) => new Set(vus.filter((v) => v.signe === signe && (skip === undefined || v.skip === skip)).map((v) => v.id));
  const ajoutes = ids('+'), skipAvant = ids('-', true);
  return {
    fichiers_supprimes: supprimes,
    tests_retires: [...ids('-')].filter((i) => !ajoutes.has(i)),
    skip_only: [...ids('+', true)].filter((i) => !skipAvant.has(i)),
  };
}

/** Banc d'une étape pour lancerBras et juger : `dir` = dossier de l'étape (demande.md, reponses.md). */
function bancEtape(s: Sequence, e: Etape, base: string): Banc {
  const dir = dirname(e.demande);
  return { id: s.id, dir, secrets: s.secrets, projet: s.projet, source: s.source, base, install: s.install, tests: s.tests,
    visible: s.visible, taille: e.taille, frais: false, reponses: existsSync(join(dir, 'reponses.md')) };
}

const mesureVide = (bras: string, banc: string, echec: string): Mesure => {
  const t = new Date().toISOString();
  return { bras, banc, debut: t, fin: t, duree_s: 0, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec };
};

/** Passage d'une séquence : un clone par bras gardé d'une étape à l'autre, une session neuve par étape, mesures par étape, juges sur l'état final. */
export function passageSequence(o: Opt): ResultatSequence {
  const bras = chargerBras(o.racine);
  for (const n of [o.ref, o.cand]) if (!bras[n]) throw new Error(`bras « ${n} » absent de ${o.racine}/bras.yaml`);
  const pret = o.pret ?? ((b) => pretAPasser(REPO, b, o.racine));
  const refus = pret({ [o.ref]: bras[o.ref], [o.cand]: bras[o.cand] });
  if (refus) throw new Error(`séquence refusée : ${refus}`);
  const liberer = verrouiller(o.racine);
  try {
    return passer(o, bras, chargerSequence(o.racine, o.id));
  } finally {
    try { rmSync(join(o.racine, 'en-cours.json'), { force: true }); } finally { liberer(); }
  }
}

const nomClone = (x: Ctx, b: string) => `c${x.noms.indexOf(b) + 1}`;

function signaler(x: Ctx, k: number, phase: string, termines: number): void {
  const f = join(x.o.racine, 'en-cours.json');
  writeFileSync(`${f}.tmp`, JSON.stringify({ run: x.run, debut: x.debut, candidat: x.o.cand, reference: x.o.ref, bancs_total: 1, banc: x.s.id,
    etape: `${k}/${x.s.etapes.length}`, repetition: 1, phase, phase_debut: new Date().toISOString(), termines }));
  renameSync(`${f}.tmp`, f);
}

/** Suite du projet du clone ; JSON brut gardé dans le dossier du run (jamais dans le clone), erreur écrite à sa place. */
function jouerSuite(x: Ctx, b: string, k: number): { passes: number; total: number; statuts: Statuts } | { erreur: string } {
  const garder = join(x.dir, `suite-${k}.${nomClone(x, b)}.json`);
  try {
    return jouerTests(x.clones[b], [], x.s.suite_projet.vitest_json.replaceAll('<k>', String(k)), x.delai, Object.keys(x.prec[b] ?? {}), garder);
  } catch (e) {
    writeFileSync(garder, JSON.stringify({ erreur: (e as Error).message }));
    return { erreur: (e as Error).message };
  }
}

function jouerBuild(x: Ctx, c: string, k: number): boolean {
  try { return shell('build', x.s.suite_projet.build, c, `${c}.build-${k}.log`, x.delai) === 0; } catch { return false; }
}

/** Étape 0 : clone à la base, suite (doit tourner) et build de référence. */
function preparerBras(x: Ctx, b: string): Base {
  signaler(x, 0, 'préparation', 0);
  (x.o.prep ?? preparer)(bancEtape(x.s, x.s.etapes[0], x.s.base), x.clones[b], x.delai);
  const r = jouerSuite(x, b, 0);
  if ('erreur' in r) throw new Error(`suite du projet à la base (${nomClone(x, b)}) : ${r.erreur}`);
  x.prec[b] = r.statuts;
  return { suite: { passes: r.passes, total: r.total }, build_ok: jouerBuild(x, x.clones[b], 0), maintenabilite: mesurerMaintenabilite(x, x.clones[b]) };
}

const mesurerMaintenabilite = (x: Ctx, c: string) => maintenabilite(c, [existsSync(join(c, 'frontend')) ? 'frontend' : '.'], x.o.jscpd);

/** Empreinte (taille, date) de chaque transcript du clone : ce qui change pendant l'étape lui appartient. */
function empreintes(x: Ctx, c: string): Map<string, string> {
  return new Map(jsonl(dossierTranscripts(x.o.home, c)).map((f) => { const st = statSync(f); return [f, `${st.size}:${st.mtimeMs}`]; }));
}

/** Lignes des transcripts de l'étape (sessions du bras, sous-agents, reprises, ou fichiers neufs ou changés pendant l'étape), triées par horodatage. */
function lignesEtape(x: Ctx, c: string, sessions: string[], avant: Map<string, string>): string[] {
  const apres = empreintes(x, c);
  const deLEtape = (f: string) => sessions.some((s) => f.includes(`/${s}.jsonl`) || f.includes(`/${s}/`)) || avant.get(f) !== apres.get(f);
  const lignes = [...apres.keys()].filter(deLEtape).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean));
  const date = (l: string) => { try { return String((JSON.parse(l) as { timestamp?: string }).timestamp ?? ''); } catch { return ''; } };
  return lignes.map((l) => ({ l, t: date(l) })).sort((a, b) => a.t.localeCompare(b.t)).map((v) => v.l);
}

/** Fuites : demandes et pièces des étapes ≤ k et ses propres fichiers de mesure permis ; le reste de la séquence et les mesures de l'autre bras, certains. */
function reglesEtape(x: Ctx, b: string, k: number): Regles {
  const r = reglesDuBras(x.o.home, x.o.racine, x.s.id, x.clones[b]);
  const mesures = (bras: string) => [`${x.clones[bras]}.reglages`, ...[0, ...x.s.etapes.map((e) => e.k)].flatMap((j) => [`${x.clones[bras]}.build-${j}.log`,
    join(x.dir, `etape-${j}.${nomClone(x, bras)}.json`), join(x.dir, `suite-${j}.${nomClone(x, bras)}.json`)])];
  r.autorises.push(...x.s.etapes.slice(0, k).flatMap((e) => [dirname(e.demande), ...e.pieces]), ...mesures(b));
  r.certains.push(join(x.o.racine, 'sequences'), ...x.noms.filter((n) => n !== b).flatMap(mesures));
  return r;
}

/** Le bras joue l'étape : un échec (y compris une exception) est noté, jamais levé. */
function lancer(x: Ctx, e: Etape, b: string, avant: { head: string; sale: string[] }, pieces: string[]): Mesure {
  const c = x.clones[b];
  try {
    const m = lancerBras(bancEtape(x.s, e, avant.head), x.bras[b], c, x.o.exec, undefined, { pieces, racine: x.o.racine });
    m.echec ??= travailNonLivre(avant, etatGit(c));
    return m;
  } catch (err) {
    return mesureVide(b, x.s.id, String(err));
  }
}

/** Une étape pour un bras : chaque mesure dans sa phase ; une mesure qui lève est notée et la séquence continue. */
function jouerEtape(x: Ctx, e: Etape, b: string): MesureEtape {
  const c = x.clones[b], transcripts = empreintes(x, c), aLire = [...e.pieces, ...e.references_depot.map((r) => join(c, r))];
  const me: MesureEtape = { k: e.k, portee_suite: x.s.suite_projet.portee, reponses: existsSync(join(dirname(e.demande), 'reponses.md')), mesure: mesureVide(b, x.s.id, 'non lancé'),
    fuites: [], fuites_a_verifier: [], suite_en_erreur: null, mesure_en_erreur: null };
  let phase = 'état avant';
  try {
    const avant = etatGit(c);
    phase = 'bras'; signaler(x, e.k, `bras ${b}`, e.k - 1);
    x.o.out(`${x.s.id} étape ${e.k}/${x.s.etapes.length} : bras ${b}…`);
    const d = x.bras[b], sceau = d.settings ? (ecrireReglages(d.settings, c), empreinteReglages(c)) : empreinteReglages(c); // R31 : réglages et hooks figés pendant l'étape
    me.mesure = lancer(x, e, b, avant, aLire);
    const contourne = empreinteReglages(c) !== sceau;
    if (me.mesure.echec) x.o.out(`${x.s.id} étape ${e.k} : bras ${b} en échec (${me.mesure.echec}), la séquence continue avec son code tel quel`);
    signaler(x, e.k, 'mesures', e.k - 1);
    phase = 'fuites'; const lignes = lignesEtape(x, c, me.mesure.sessions, transcripts);
    const fu = chercherFuites(lignes, reglesEtape(x, b, e.k), x.o.home, c);
    me.fuites = [...(contourne ? [`contournement : réglages ou hooks du bras modifiés pendant l'étape (${cheminReglages(c)}, v2/hooks, .claude du clone)`] : []), ...fu.certaines];
    me.fuites_a_verifier = fu.a_verifier;
    phase = 'lecture'; me.lecture = lectureReferences(lignes, aLire, c);
    phase = 'suite'; const r = jouerSuite(x, b, e.k);
    if ('erreur' in r) me.suite_en_erreur = r.erreur; // l'étape suivante se compare à la dernière mesure réussie
    else {
      const d = ecart(x.prec[b], r.statuts);
      me.suite = { passes: r.passes, total: r.total };
      me.regressions = { rouges: d.rouges, disparus: d.disparus };
      me.nouveaux = d.nouveaux;
      x.prec[b] = r.statuts;
    }
    phase = 'tests affaiblis'; me.tests_affaiblis = testsAffaiblis(c, avant.head);
    phase = 'build'; me.build_ok = jouerBuild(x, c, e.k);
    phase = 'maintenabilité'; me.maintenabilite = mesurerMaintenabilite(x, c);
  } catch (err) {
    me.mesure_en_erreur = `${phase} : ${(err as Error).message}`;
  }
  const cn = nomClone(x, b); // anonyme jusqu'aux juges (R9)
  writeFileSync(join(x.dir, `etape-${e.k}.${cn}.json`), JSON.stringify({ ...me, mesure: { ...me.mesure, bras: cn } }, null, 2));
  return me;
}

/** Champ {{DEMANDES}} des juges : toutes les demandes, et la règle unique d'adaptation des tests cachés d'origine. */
function demandesDuJuge(s: Sequence): string {
  const demandes = s.etapes.map((e) => `${e.k}. ${readFileSync(e.demande, 'utf8').trim()}`).join('\n\n');
  const caches = [...s.etapes.map((e) => `étape ${e.k} : ${s.caches[e.k].fichiers.join(', ')} (${s.caches[e.k].commande})`),
    `régression dès l'étape ${s.regression.a_partir_de} : ${s.regression.fichiers.join(', ')} (${s.regression.commande})`];
  return `\n\nCe que tu juges est l'état final d'une suite de ${s.etapes.length} demandes successives (demande.md = la dernière) ; juge l'ensemble, base..HEAD de toute la suite :\n${demandes}\n\n`
    + 'Tests cachés d\'origine, écrits pour le code d\'origine. Règle unique, la même pour X et Y : adapte seulement les sélecteurs, imports et noms renommés ; '
    + 'quand une demande ULTÉRIEURE change un comportement testé par un test d\'une demande antérieure, c\'est la demande ultérieure qui fait foi : '
    + 'marque ce test « remplacé par l\'étape k » au lieu de le compter, et liste-le dans le champ "remplaces" (une seule liste pour X et Y, décidée avant de juger l\'une ou l\'autre).\n'
    + `${caches.join('\n')}\n`;
}

function passer(o: Opt, bras: Record<string, DefBras>, s: Sequence): ResultatSequence {
  const p = parisJour(o.maintenant), run = `${p.jour}-${p.hhmm}-${o.empreinte}`;
  const dir = join(o.racine, 'runs', run, s.id);
  const tirage = o.tirage ?? Math.random;
  const noms = tirage() < 0.5 ? [o.ref, o.cand] : [o.cand, o.ref]; // R9 : clones c1/c2, correspondance écrite après les juges
  const x: Ctx = { o, s, bras, run, dir, debut: new Date().toISOString(), delai: o.delaiMs ?? 30 * 60_000, noms, clones: {}, prec: {} };
  for (const b of noms) x.clones[b] = join(dir, nomClone(x, b));
  mkdirSync(dir, { recursive: true });
  const heads: Record<string, string> = {};
  try {
    const base: Record<string, Base> = {};
    for (const b of noms) { base[b] = preparerBras(x, b); heads[b] = etatGit(x.clones[b]).head; }
    const etapes: Record<string, MesureEtape[]> = Object.fromEntries(noms.map((b) => [b, []]));
    for (const e of s.etapes) {
      const ordre = e.k % 2 ? [o.ref, o.cand] : [o.cand, o.ref];
      for (const b of ordre) etapes[b].push(jouerEtape(x, e, b));
    }
    signaler(x, s.etapes.length, 'juges', s.etapes.length);
    const dernier = bancEtape(s, s.etapes[s.etapes.length - 1], heads[noms[0]]);
    const jugement = juger(dernier, x.clones, join(o.racine, 'eval', run, s.id), o.juge, o.exec, tirage, demandesDuJuge(s));
    const clones = Object.fromEntries(noms.map((b) => [nomClone(x, b), b]));
    const res: ResultatSequence = { run, sequence: s.id, clones, base, etapes, jugement };
    writeFileSync(join(dir, 'resultat.json'), JSON.stringify(res, null, 2));
    return res;
  } finally {
    for (const b of noms) if (o.garderClones) libererReglages(x.clones[b]); else archiver(x.clones[b], heads[b]);
  }
}
