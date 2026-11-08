import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Banc } from '../bench/banc.js';
import { chargerBras, lancerBras, type DefBras, type Executeur, type Mesure } from '../bench/bras.js';
import { archiver, pretAPasser, verrouiller } from '../bench/cli.js';
import { chercherFuites, dossierTranscripts, jsonl, reglesDuBras } from '../bench/fuites.js';
import { etatGit, juger, travailNonLivre, type Jugement } from '../bench/juges.js';
import { preparer, shell } from '../bench/preparer.js';
import { parisJour } from '../bench/verdict.js';
import { jouerTests, lectureReferences, maintenabilite, regressions } from './mesures.js';
import { chargerSequence, type Etape, type Sequence } from './sequence.js';

export interface Affaiblis { fichiers_supprimes: number; tests_retires: number; skip_only_ajoutes: number }
export interface MesureEtape { k: number; mesure: Mesure; fuites: string[]; fuites_a_verifier: string[]; lecture: ReturnType<typeof lectureReferences>;
  suite: { passes: number; total: number; erreur?: string }; regressions: string[]; tests_affaiblis: Affaiblis; build_ok: boolean; maintenabilite: ReturnType<typeof maintenabilite> }
export interface ResultatSequence { run: string; sequence: string; clones: Record<string, string>; etapes: Record<string, MesureEtape[]>; jugement: Jugement | null }
type Opt = { racine: string; id: string; ref: string; cand: string; juge: string; exec: Executeur; maintenant: Date; empreinte: string; home: string; out: (l: string) => void;
  prep?: typeof preparer; pret?: (b: Record<string, DefBras>) => string | null; jscpd?: string[]; delaiMs?: number; garderClones?: boolean; tirage?: () => number };

const REPO = join(import.meta.dirname, '..', '..', '..');
const IT = /\b(it|test)(\.\w+)?\s*\(/, SKIP = /\.(skip|only)\s*\(/;

/** Tests affaiblis depuis `avant` (commits et copie de travail) : fichiers de test supprimés, `it(`/`test(` retirés, `.skip`/`.only` ajoutés (soldes nets). */
export function testsAffaiblis(clone: string, avant: string): Affaiblis {
  const d = execFileSync('git', ['diff', avant, '--', ':(glob)**/*.spec.*', ':(glob)**/*.test.*'], { cwd: clone, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\n');
  const n = (s: string, re: RegExp) => d.filter((l) => l.startsWith(s) && !l.startsWith(s.repeat(3)) && re.test(l)).length;
  return { fichiers_supprimes: d.filter((l) => l.startsWith('deleted file mode')).length,
    tests_retires: Math.max(0, n('-', IT) - n('+', IT)), skip_only_ajoutes: Math.max(0, n('+', SKIP) - n('-', SKIP)) };
}

/** Banc d'une étape pour lancerBras et juger : `dir` = dossier de l'étape (demande.md, reponses.md), `base` = HEAD avant l'étape. */
const bancEtape = (s: Sequence, e: Etape, base: string): Banc => ({ id: s.id, dir: dirname(e.demande), secrets: s.secrets, projet: s.projet, source: s.source, base,
  install: s.install, tests: s.tests, visible: s.visible, taille: e.taille, frais: false, reponses: existsSync(join(dirname(e.demande), 'reponses.md')) });

/** Passage d'une séquence : un clone par bras gardé d'une étape à l'autre, une session neuve par étape, mesures par étape, juges sur l'état final. */
export function passageSequence(o: Opt): ResultatSequence {
  const bras = chargerBras(o.racine);
  for (const n of [o.ref, o.cand]) if (!bras[n]) throw new Error(`bras « ${n} » absent de ${o.racine}/bras.yaml`);
  const refus = (o.pret ?? ((b) => pretAPasser(REPO, b, o.racine)))({ [o.ref]: bras[o.ref], [o.cand]: bras[o.cand] });
  if (refus) throw new Error(`séquence refusée : ${refus}`);
  const liberer = verrouiller(o.racine);
  try { return passer(o, bras, chargerSequence(o.racine, o.id)); } finally { try { rmSync(join(o.racine, 'en-cours.json'), { force: true }); } finally { liberer(); } }
}

function passer(o: Opt, bras: Record<string, DefBras>, s: Sequence): ResultatSequence {
  const p = parisJour(o.maintenant), run = `${p.jour}-${p.hhmm}-${o.empreinte}`, dir = join(o.racine, 'runs', run, s.id), n = s.etapes.length, debut = new Date().toISOString(), delai = o.delaiMs ?? 30 * 60_000;
  const noms = (o.tirage ?? Math.random)() < 0.5 ? [o.ref, o.cand] : [o.cand, o.ref]; // R9 : clones c1/c2, correspondance écrite après les juges
  const cn = (b: string) => `c${noms.indexOf(b) + 1}`, clones = Object.fromEntries(noms.map((b) => [b, join(dir, cn(b))]));
  const aller = (k: number, phase: string, termines = 0) => {
    const f = join(o.racine, 'en-cours.json'); writeFileSync(`${f}.tmp`, JSON.stringify({ run, debut, candidat: o.cand, reference: o.ref, bancs_total: 1, banc: s.id, etape: `${k}/${n}`, repetition: 1, phase, phase_debut: new Date().toISOString(), termines }));
    renameSync(`${f}.tmp`, f);
  };
  const suite = (c: string, k: number, connus: string[]) => {
    try { const r = jouerTests(c, [], s.suite_projet.vitest_json.replaceAll('<k>', String(k)), delai, connus); return { passes: r.passes, total: r.total, statuts: r.statuts }; }
    catch (e) { return { passes: 0, total: 0, statuts: {} as Record<string, boolean>, erreur: (e as Error).message }; } // échec fermé : chaque vert d'avant devient une régression
  };
  const etapes: Record<string, MesureEtape[]> = Object.fromEntries(noms.map((b) => [b, []]));
  const prec: Record<string, Record<string, boolean>> = {}, heads: Record<string, string> = {};
  try {
    for (const b of noms) {
      aller(0, 'préparation'); (o.prep ?? preparer)(bancEtape(s, s.etapes[0], s.base), clones[b], delai);
      heads[b] = etatGit(clones[b]).head; const r = suite(clones[b], 0, []);
      if (r.erreur) throw new Error(`suite du projet à la base (${cn(b)}) : ${r.erreur}`); prec[b] = r.statuts;
    }
    for (const e of s.etapes) for (const b of e.k % 2 ? [o.ref, o.cand] : [o.cand, o.ref]) {
      const c = clones[b], avant = etatGit(c);
      aller(e.k, `bras ${b}`, e.k - 1); o.out(`${s.id} étape ${e.k}/${n} : bras ${b}…`);
      let m: Mesure;
      try { m = lancerBras(bancEtape(s, e, avant.head), bras[b], c, o.exec); m.echec ??= travailNonLivre(avant, etatGit(c)); } catch (x) {
        const t = new Date().toISOString(); m = { bras: b, banc: s.id, debut: t, fin: t, duree_s: 0, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: String(x) };
      }
      if (m.echec) o.out(`${s.id} étape ${e.k} : bras ${b} en échec (${m.echec}), la séquence continue avec son code tel quel`);
      aller(e.k, 'mesures', e.k - 1);
      const lignes = jsonl(dossierTranscripts(o.home, c)).filter((f) => m.sessions.some((x) => f.includes(x))).flatMap((f) => readFileSync(f, 'utf8').split('\n'));
      const regles = reglesDuBras(o.home, o.racine, s.id, c); // pièces des étapes ≤ k permises ; le reste de la séquence (demandes futures) est une fuite certaine
      regles.autorises.push(...s.etapes.slice(0, e.k).flatMap((x) => [dirname(x.demande), ...x.pieces])); regles.certains.push(join(o.racine, 'sequences'));
      const fu = chercherFuites(lignes, regles, o.home, c);
      const r = suite(c, e.k, Object.keys(prec[b]));
      const me: MesureEtape = { k: e.k, mesure: m, fuites: fu.certaines, fuites_a_verifier: fu.a_verifier,
        lecture: lectureReferences(lignes, [...e.pieces, ...e.references_depot.map((x) => join(c, x))], c),
        suite: { passes: r.passes, total: r.total, ...(r.erreur && { erreur: r.erreur }) }, regressions: regressions(prec[b], r.statuts), tests_affaiblis: testsAffaiblis(c, avant.head),
        build_ok: (() => { try { return shell('build', s.suite_projet.build, c, `${c}.build-${e.k}.log`, delai) === 0; } catch { return false; } })(),
        maintenabilite: maintenabilite(c, [existsSync(join(c, 'frontend')) ? 'frontend' : '.'], o.jscpd) };
      prec[b] = r.statuts; etapes[b].push(me);
      writeFileSync(join(dir, `etape-${e.k}.${cn(b)}.json`), JSON.stringify({ ...me, mesure: { ...m, bras: cn(b) } }, null, 2)); // anonyme jusqu'aux juges (R9)
    }
    aller(n, 'juges', n);
    const caches = [...s.etapes.map((e) => `étape ${e.k} : ${s.caches[e.k].fichiers.join(', ')} (${s.caches[e.k].commande})`),
      `régression dès l'étape ${s.regression.a_partir_de} : ${s.regression.fichiers.join(', ')} (${s.regression.commande})`];
    const demandes = `\n\nCe que tu juges est l'état final d'une suite de ${n} demandes successives (demande.md = la dernière) ; juge l'ensemble, base..HEAD de toute la suite :\n${
      s.etapes.map((e) => `${e.k}. ${readFileSync(e.demande, 'utf8').trim()}`).join('\n\n')}\n\nTests cachés d'origine, écrits pour le code d'origine : adapte-les à l'état final, avec exactement la même méthode pour X et Y :\n${caches.join('\n')}\n`;
    const jugement = juger(bancEtape(s, s.etapes[n - 1], heads[noms[0]]), clones, join(o.racine, 'eval', run, s.id), o.juge, o.exec, Math.random, demandes);
    const res: ResultatSequence = { run, sequence: s.id, clones: Object.fromEntries(noms.map((b) => [cn(b), b])), etapes, jugement };
    writeFileSync(join(dir, 'resultat.json'), JSON.stringify(res, null, 2)); return res;
  } finally { if (!o.garderClones) for (const b of noms) archiver(clones[b], heads[b]); }
}
