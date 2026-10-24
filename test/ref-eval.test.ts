import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { ROLES, checkInventaire } from '../src/ref/check.js';
import { buildCorpus } from '../src/ref/corpus.js';
import { tempDir } from './helpers.js';

type Obj = Record<string, any>;

const SHA = 'b'.repeat(64);
const src = { page: 1, zone: { x: 10, y: 20, l: 100, h: 40 } };
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

const texte = (n: number, libelle: string, extra: Obj = {}): Obj => ({ type: 'texte', id: `cas#texte-${n}`, source: src, confiance: 'lu', libelle, role: 'titre', ...extra });
const lien = (n: number, constat: string, extra: Obj = {}): Obj => ({
  type: 'lien', id: `cas#lien-${n}`, source: src, confiance: 'lu', figure: 'Figure 1', passage: { page: 1, ligne: 2, extrait: 'voir la figure' }, constat,
  ...(constat === 'precise' ? { lecture_ambigue: 'a ou b', interpretation: 'a', raison: 'la figure' } : {}), ...extra,
});
const composant = (n: number, contenu: string, extra: Obj = {}): Obj => ({ type: 'composant', id: `cas#composant-${n}`, source: src, confiance: 'lu', role: 'bouton', position: { x: 1, y: 2 }, taille: { l: 3, h: 4 }, contenu, ecran: 'cas#ecran-1', ...extra });
const ecran: Obj = { type: 'ecran', id: 'cas#ecran-1', source: src, confiance: 'mesure', largeur_reference: 1440, zones: [{ nom: 'tout', x: 0, y: 0, l: 1440, h: 900, pct: { x: 0, y: 0, l: 100, h: 100 } }] };
const table = (n: number, lignes: string[][], extra: Obj = {}): Obj => ({ type: 'table', id: `cas#table-${n}`, source: src, confiance: 'lu', colonnes: ['Code', 'Sens'], lignes, ...extra });

const doc = (genre: string, elements: Obj[], extra: Obj = {}): Obj => ({ version: 1, genre, document: { slug: 'cas', sha256: SHA }, pages: 2, elements: clone(elements), ...extra });

interface Result {
  code: number;
  out: string;
  err: string;
  json: Obj;
}

/** `cadence ref eval` sur un attendu et une lecture écrits dans un dossier jetable ; `--json` relu quand la sortie en est une. */
function evaluer(attendu: Obj, lecture: Obj, args: string[] = []): Result {
  const dir = tempDir();
  writeFileSync(join(dir, 'attendu.json'), JSON.stringify(attendu));
  writeFileSync(join(dir, 'lecture.json'), JSON.stringify(lecture));
  return lancer([join(dir, 'attendu.json'), join(dir, 'lecture.json'), ...args], dir);
}

function lancer(args: string[], cwd: string): Result {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['ref', 'eval', ...args], { cwd, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-24T10:00:00') }) as number;
  const text = out.join('\n');
  let json: Obj = {};
  if (args.includes('--json')) json = JSON.parse(text);
  return { code, out: text, err: err.join('\n'), json };
}

const ATTENDU = doc('inventaire', [ecran, composant(1, 'Valider'), texte(1, 'Titre'), table(1, [['A', 'alpha'], ['B', 'beta']]), lien(1, 'precise', { piege: 'texte-ambigu' })]);

describe('cadence ref eval — rappel, précision, faux lu, tokens par page', () => {
  it('R1 — une lecture identique à l’attendu a un rappel, une précision de 100 % et aucun faux lu', () => {
    const r = evaluer(ATTENDU, doc('lecture', ATTENDU.elements));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('rappel : 100 % (5/5)');
    expect(r.out).toContain('précision : 100 % (5/5)');
    expect(r.out).toContain('faux lu : 0 % (0/5 sûrs)');
  });

  it('R2 — le rappel se compte par type : un élément oublié baisse le type, pas les autres', () => {
    const lus = ATTENDU.elements.filter((e: Obj) => e.type !== 'texte');
    const r = evaluer(ATTENDU, doc('lecture', lus), ['--json']);
    expect(r.json.total.rappel).toBeCloseTo(4 / 5);
    expect(r.json.types.texte).toMatchObject({ attendus: 1, justes: 0, rappel: 0 });
    expect(r.json.types.table).toMatchObject({ attendus: 1, justes: 1, rappel: 1 });
    expect(r.json.total.precision).toBe(1);
  });

  it('R3 — la précision baisse quand la lecture ajoute un élément qui n’est pas dans l’attendu', () => {
    const r = evaluer(ATTENDU, doc('lecture', [...ATTENDU.elements, texte(2, 'Inventé', { confiance: 'incertain', cause: 'flou' })]), ['--json']);
    expect(r.json.total.precision).toBeCloseTo(5 / 6);
    expect(r.json.types.texte.precision).toBeCloseTo(1 / 2);
    expect(r.json.total.rappel).toBe(1);
  });

  it('R4 — un élément en trop marqué lu est un faux lu ; marqué incertain, il n’en est pas un', () => {
    const sur = evaluer(ATTENDU, doc('lecture', [...ATTENDU.elements, texte(2, 'Inventé')]), ['--json']);
    expect(sur.json.total).toMatchObject({ sures: 6, faux_lu: 1 });
    expect(sur.json.total.taux_faux_lu).toBeCloseTo(1 / 6);
    const incertain = evaluer(ATTENDU, doc('lecture', [...ATTENDU.elements, texte(2, 'Inventé', { confiance: 'incertain', cause: 'flou' })]), ['--json']);
    expect(incertain.json.total).toMatchObject({ sures: 5, faux_lu: 0, taux_faux_lu: 0 });
  });

  it('R5 — une cellule fausse dans une table lue sûre est un faux lu : la table n’est pas juste, elle ne compte pas dans le rappel', () => {
    const lue = ATTENDU.elements.map((e: Obj) => (e.type === 'table' ? table(1, [['A', 'alpha'], ['B', 'gamma']]) : e));
    const r = evaluer(ATTENDU, doc('lecture', lue), ['--json']);
    expect(r.json.types.table).toMatchObject({ attendus: 1, lus: 1, justes: 0, faux_lu: 1 });
    expect(r.json.total.rappel).toBeCloseTo(4 / 5);
  });

  it('R6 — la même table lue incertain garde le rappel à zéro mais n’ajoute pas de faux lu', () => {
    const lue = ATTENDU.elements.map((e: Obj) => (e.type === 'table' ? table(1, [['A', 'alpha'], ['B', 'gamma']], { confiance: 'incertain', cause: 'cellule illisible' }) : e));
    const r = evaluer(ATTENDU, doc('lecture', lue), ['--json']);
    expect(r.json.types.table).toMatchObject({ justes: 0, faux_lu: 0 });
  });

  it('R7 — l’identité d’un élément ignore ses id, sa zone et la casse : deux lectures indépendantes numérotent à leur façon', () => {
    const lue = [texte(7, 'TITRE', { source: { page: 3, zone: { x: 1, y: 1, l: 5, h: 5 } } }), ...ATTENDU.elements.filter((e: Obj) => e.type !== 'texte')];
    const r = evaluer(ATTENDU, doc('lecture', lue), ['--json']);
    expect(r.json.types.texte).toMatchObject({ justes: 1, rappel: 1 });
  });

  it('R8 — un élément attendu n’est apparié qu’une fois : deux lectures identiques font un élément en trop', () => {
    const r = evaluer(ATTENDU, doc('lecture', [...ATTENDU.elements, texte(2, 'Titre')]), ['--json']);
    expect(r.json.types.texte).toMatchObject({ attendus: 1, lus: 2, justes: 1, faux_lu: 1 });
  });

  it('R9 — un piège est trouvé quand son élément est juste : un lien precise lu confirme manque le piège', () => {
    const bon = evaluer(ATTENDU, doc('lecture', ATTENDU.elements), ['--json']);
    expect(bon.json.pieges).toEqual([{ piege: 'texte-ambigu', attendus: 1, trouves: 1 }]);
    const lue = ATTENDU.elements.map((e: Obj) => (e.type === 'lien' ? lien(1, 'confirme') : e));
    const rate = evaluer(ATTENDU, doc('lecture', lue), ['--json']);
    expect(rate.json.pieges).toEqual([{ piege: 'texte-ambigu', attendus: 1, trouves: 0 }]);
    expect(evaluer(ATTENDU, doc('lecture', lue)).out).toContain('✗ texte-ambigu : 0/1');
  });

  it('R10 — les tokens par page sont la somme des usages lus divisée par les pages des cas lus', () => {
    const r = evaluer(ATTENDU, doc('lecture', ATTENDU.elements, { usage: { tokens: 3000 } }), ['--json']);
    expect(r.json.tokens).toEqual({ total: 3000, pages: 2, par_page: 1500 });
    expect(evaluer(ATTENDU, doc('lecture', ATTENDU.elements, { usage: { tokens: 3000 } })).out).toContain('tokens par page : 1500 (3000 sur 2 pages)');
  });

  it('R11 — sans usage dans la lecture, les tokens par page ne sont pas mesurés (pas de zéro inventé)', () => {
    const r = evaluer(ATTENDU, doc('lecture', ATTENDU.elements), ['--json']);
    expect(r.json.tokens).toEqual({ total: null, pages: null, par_page: null });
    expect(evaluer(ATTENDU, doc('lecture', ATTENDU.elements)).out).toContain('tokens par page : non mesurés');
  });

  it('R12 — une lecture d’un autre document (slug ou empreinte) est refusée : jamais de mesure sur deux versions mêlées', () => {
    const autre = doc('lecture', ATTENDU.elements);
    autre.document.sha256 = 'c'.repeat(64);
    const r = evaluer(ATTENDU, autre);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/empreinte/);
    const autreSlug = doc('lecture', ATTENDU.elements);
    autreSlug.document.slug = 'autre';
    expect(evaluer(ATTENDU, autreSlug).err).toMatch(/slug/);
  });

  it('R13 — une lecture qui ne passe pas ref check est refusée avec le premier écart, un attendu qui n’est pas un inventaire aussi', () => {
    const cassee = doc('lecture', [texte(1, 'Titre', { confiance: 'peut-être' })]);
    const r = evaluer(ATTENDU, cassee);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/lecture.*confiance/s);
    const pasInventaire = evaluer(doc('lecture', ATTENDU.elements), doc('lecture', ATTENDU.elements));
    expect(pasInventaire.code).toBe(2);
    expect(pasInventaire.err).toMatch(/inventaire/);
  });

  it('R14 — un appel sans deux arguments, ou sur un fichier absent, est un refus d’usage (code 2)', () => {
    const dir = tempDir();
    const r = lancer([join(dir, 'a.json')], dir);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage : cadence ref eval/);
    expect(lancer([join(dir, 'a.json'), join(dir, 'b.json')], dir).err).toMatch(/introuvable/);
  });

  it('R15 — sur un dossier, chaque cas du corpus est lu dans le dossier des lectures ; un cas sans lecture compte pour un rappel nul et est nommé', () => {
    const dir = tempDir();
    const second = doc('inventaire', [texte(1, 'Autre')], { pages: 1 });
    second.document.slug = 'cas';
    for (const [nom, d] of [['un', ATTENDU], ['deux', second]] as const) {
      mkdirSync(join(dir, 'corpus', nom), { recursive: true });
      writeFileSync(join(dir, 'corpus', nom, 'attendu.json'), JSON.stringify(d));
    }
    mkdirSync(join(dir, 'lectures', 'un'), { recursive: true });
    writeFileSync(join(dir, 'lectures', 'un', 'lecture.json'), JSON.stringify(doc('lecture', ATTENDU.elements, { usage: { tokens: 1000 } })));
    const r = lancer([join(dir, 'corpus'), join(dir, 'lectures'), '--json'], dir);
    expect(r.code).toBe(0);
    expect(r.json.total).toMatchObject({ attendus: 6, justes: 5 });
    expect(r.json.cas.map((c: Obj) => [c.cas, c.lecture])).toEqual([['deux', false], ['un', true]]);
    expect(r.json.tokens).toEqual({ total: 1000, pages: 2, par_page: 500 });
    expect(lancer([join(dir, 'corpus'), join(dir, 'lectures')], dir).out).toContain('sans lecture : deux');
  });

  it('R16 — un dossier sans aucun attendu est refusé', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'vide'));
    const r = lancer([join(dir, 'vide'), join(dir, 'vide')], dir);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/aucun attendu\.json/);
  });

  it('R17 — un statut est juste quand il couvre les mêmes éléments, quels que soient leurs id', () => {
    const attendu = doc('inventaire', [ecran, composant(1, 'Panneau'), { type: 'statut', id: 'cas#statut-1', source: src, confiance: 'lu', libelle: 'Proposal', couvre: ['cas#composant-1'] }]);
    const lue = doc('lecture', [ecran, composant(4, 'Panneau', { id: 'cas#composant-4' }), { type: 'statut', id: 'cas#statut-9', source: src, confiance: 'lu', libelle: 'proposal', couvre: ['cas#composant-4'] }]);
    expect(evaluer(attendu, lue, ['--json']).json.types.statut).toMatchObject({ justes: 1 });
    const faux = doc('lecture', [ecran, composant(4, 'Panneau', { id: 'cas#composant-4' }), { type: 'statut', id: 'cas#statut-9', source: src, confiance: 'lu', libelle: 'Proposal', couvre: ['cas#ecran-1'] }]);
    expect(evaluer(attendu, faux, ['--json']).json.types.statut).toMatchObject({ justes: 0, faux_lu: 1 });
  });
  it('R18 — les rôles sont une liste fermée : « label » pour « etiquette-figure » est refusé au schéma, une lecture parfaite aux rôles de la liste a un faux lu de 0 %', () => {
    const dir = tempDir();
    const corpus = buildCorpus();
    for (const c of corpus) {
      mkdirSync(join(dir, 'corpus', c.nom), { recursive: true });
      mkdirSync(join(dir, 'lectures', c.nom), { recursive: true });
      writeFileSync(join(dir, 'corpus', c.nom, 'attendu.json'), JSON.stringify(c.inventaire));
      writeFileSync(join(dir, 'lectures', c.nom, 'lecture.json'), JSON.stringify(c.inventaire));
    }
    const parfaite = lancer([join(dir, 'corpus'), join(dir, 'lectures'), '--json'], dir);
    expect(parfaite.code).toBe(0);
    expect(parfaite.json.total).toMatchObject({ faux_lu: 0, rappel: 1, precision: 1, taux_faux_lu: 0 });

    const ambigu = clone(corpus.find((c) => c.nom === 'texte-ambigu-leve-par-figure')!.inventaire) as Obj;
    let renommes = 0;
    for (const e of ambigu.elements) if (e.role === 'etiquette-figure') { e.role = 'label'; renommes++; }
    expect(renommes).toBe(3);
    expect(checkInventaire(ambigu)).toContain("elements[2].role : « label » n'est pas un rôle de la liste : " + Object.keys(ROLES).join(', '));
    writeFileSync(join(dir, 'lectures', 'texte-ambigu-leve-par-figure', 'lecture.json'), JSON.stringify(ambigu));
    const r = lancer([join(dir, 'corpus'), join(dir, 'lectures')], dir);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/lecture.*pas valide.*« label » n'est pas un rôle/s);
  });
  it('R18 — un rôle valide mais différent de l’attendu (paragraphe pour titre) est un faux lu : le texte est retrouvé, il n’est pas juste', () => {
    const lue = ATTENDU.elements.map((e: Obj) => (e.type === 'texte' ? texte(1, 'Titre', { role: 'paragraphe' }) : e));
    const r = evaluer(ATTENDU, doc('lecture', lue), ['--json']);
    expect(checkInventaire(doc('lecture', lue))).toEqual([]);
    expect(r.json.types.texte).toMatchObject({ attendus: 1, lus: 1, justes: 0, faux_lu: 1, rappel: 0 });
  });
  it('R20 — le corpus contre lui-même affiche une ligne par type, états compris : le rappel des composants et des états est mesurable', () => {
    const dir = tempDir();
    for (const c of buildCorpus()) {
      for (const [d, f] of [['corpus', 'attendu.json'], ['lectures', 'lecture.json']] as const) {
        mkdirSync(join(dir, d, c.nom), { recursive: true });
        writeFileSync(join(dir, d, c.nom, f), JSON.stringify(c.inventaire));
      }
    }
    const r = lancer([join(dir, 'corpus'), join(dir, 'lectures')], dir);
    expect(r.out).toMatch(/^ {2}etat {7}rappel 100 % \(2\/2\) · précision 100 % \(2\/2\) · faux lu 0\/2$/m);
    expect(r.out).toMatch(/^ {2}composant {2}rappel 100 %/m);
    const json = lancer([join(dir, 'corpus'), join(dir, 'lectures'), '--json'], dir).json;
    expect(json.types.etat).toMatchObject({ attendus: 2, justes: 2 });
    expect(json.types.lien.attendus).toBe(3);
  });
  describe('ce que chaque type affirme une fois retrouvé : une affirmation fausse est un faux lu, jamais un rappel', () => {
    const etat = (n: number, cible: string, extra: Obj = {}): Obj => ({ type: 'etat', id: `cas#etat-${n}`, source: src, confiance: 'lu', nom: 'desactive', cible, ...extra });
    const gabarit = (champs: Obj[], extra: Obj = {}): Obj => ({ type: 'gabarit', id: 'cas#gabarit-1', source: src, confiance: 'lu', nom: 'Section 1', champs, ...extra });
    const champs = (): Obj[] => [{ nom: 'date', obligatoire: true, format: 'AAAAMMJJ' }, { nom: 'vent', obligatoire: false, format: 'entier', min: 0, max: 360 }];
    const schema = (flux: Obj[], noeuds: Obj[] = [{ id: 'a', libelle: 'Capteur' }, { id: 'b', libelle: 'Serveur' }]): Obj => ({ type: 'schema', id: 'cas#schema-1', source: src, confiance: 'lu', noeuds, flux });
    const fluxAB = (extra: Obj = {}): Obj => ({ de: 'a', vers: 'b', libelle: 'envoie', direction: 'de_vers', ...extra });
    const compte = (attendu: Obj[], lus: Obj[], type: string): Obj => evaluer(doc('inventaire', attendu), doc('lecture', lus), ['--json']).json.types[type];

    it('R21 — un état est retrouvé par son nom et l’identité de sa cible, pas par l’id de la cible ; sur un autre composant il est un faux lu', () => {
      const base = [ecran, composant(1, 'Valider'), composant(2, 'Annuler')];
      const attendu = [...base, etat(1, 'cas#composant-1')];
      expect(compte(attendu, [...base, etat(5, 'cas#composant-1', { id: 'cas#etat-5' })], 'etat')).toMatchObject({ attendus: 1, justes: 1, faux_lu: 0 });
      const renumerotes = [ecran, composant(7, 'Valider', { id: 'cas#composant-7' }), composant(8, 'Annuler', { id: 'cas#composant-8' }), etat(1, 'cas#composant-7')];
      expect(compte(attendu, renumerotes, 'etat')).toMatchObject({ justes: 1, faux_lu: 0 });
      expect(compte(attendu, [...base, etat(1, 'cas#composant-2')], 'etat')).toMatchObject({ attendus: 1, lus: 1, justes: 0, faux_lu: 1, rappel: 0 });
      expect(compte(attendu, [...base, etat(1, 'cas#composant-1', { nom: 'chargement' })], 'etat')).toMatchObject({ justes: 0, faux_lu: 1 });
    });

    it('R22 — un écran est juste à la même largeur de référence ; à une autre il est retrouvé mais faux lu', () => {
      const autre = { ...ecran, largeur_reference: 390 };
      expect(compte([ecran], [ecran], 'ecran')).toMatchObject({ justes: 1, faux_lu: 0 });
      expect(compte([ecran], [autre], 'ecran')).toMatchObject({ attendus: 1, lus: 1, justes: 0, faux_lu: 1, rappel: 0 });
    });

    it('R23 — un composant se retrouve par son rôle et son contenu : un autre rôle est un composant manqué et un composant en trop', () => {
      const r = compte([ecran, composant(1, 'Valider')], [ecran, composant(1, 'Valider', { role: 'champ' })], 'composant');
      expect(r).toMatchObject({ attendus: 1, lus: 1, justes: 0, faux_lu: 1, rappel: 0, precision: 0 });
    });

    it('R24 — un gabarit à un champ faux (obligatoire, format, borne) est un faux lu ; les mêmes champs sont justes', () => {
      const attendu = [gabarit(champs())];
      expect(compte(attendu, [gabarit(champs())], 'gabarit')).toMatchObject({ justes: 1, faux_lu: 0 });
      for (const [nom, change] of [['obligatoire', { obligatoire: true }], ['format', { format: 'texte' }], ['max', { max: 359 }], ['min', { min: 1 }]] as const) {
        const faux = champs();
        Object.assign(faux[1]!, change);
        expect(compte(attendu, [gabarit(faux)], 'gabarit'), nom).toMatchObject({ attendus: 1, lus: 1, justes: 0, faux_lu: 1 });
      }
      expect(compte(attendu, [gabarit(champs().reverse())], 'gabarit'), 'ordre des champs').toMatchObject({ justes: 0, faux_lu: 1 });
    });

    it('R25 — un schéma est retrouvé par ses nœuds ; un flux inversé, un libellé de flux ou une direction faux sont des faux lus, l’ordre des flux ne compte pas', () => {
      const attendu = [schema([fluxAB()])];
      expect(compte(attendu, [schema([fluxAB()])], 'schema')).toMatchObject({ justes: 1, faux_lu: 0 });
      const inverse = schema([fluxAB({ de: 'b', vers: 'a' })]);
      expect(compte(attendu, [inverse], 'schema')).toMatchObject({ attendus: 1, lus: 1, justes: 0, faux_lu: 1, rappel: 0 });
      expect(compte(attendu, [schema([fluxAB({ libelle: 'reçoit' })])], 'schema')).toMatchObject({ justes: 0, faux_lu: 1 });
      expect(compte(attendu, [schema([fluxAB({ direction: 'bidirectionnel' })])], 'schema')).toMatchObject({ justes: 0, faux_lu: 1 });
      const deux = [{ id: 'a', libelle: 'Capteur' }, { id: 'b', libelle: 'Serveur' }, { id: 'c', libelle: 'Écran' }];
      const f2 = { de: 'b', vers: 'c', libelle: 'affiche', direction: 'de_vers' };
      expect(compte([schema([fluxAB(), f2], deux)], [schema([f2, fluxAB()], deux)], 'schema')).toMatchObject({ justes: 1, faux_lu: 0 });
      const renomme = schema([fluxAB()], [{ id: 'a', libelle: 'Sonde' }, { id: 'b', libelle: 'Serveur' }]);
      expect(compte(attendu, [renomme], 'schema')).toMatchObject({ justes: 0, faux_lu: 1 });
    });
  });
  it('R19 — un fichier contre un dossier (dans un sens ou dans l’autre) est refusé avec les combinaisons acceptées, jamais une lecture ignorée en silence', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'corpus', 'un'), { recursive: true });
    writeFileSync(join(dir, 'corpus', 'un', 'attendu.json'), JSON.stringify(ATTENDU));
    writeFileSync(join(dir, 'lecture.json'), JSON.stringify(doc('lecture', ATTENDU.elements)));
    writeFileSync(join(dir, 'attendu.json'), JSON.stringify(ATTENDU));
    mkdirSync(join(dir, 'lectures', 'un'), { recursive: true });
    writeFileSync(join(dir, 'lectures', 'un', 'lecture.json'), JSON.stringify(doc('lecture', ATTENDU.elements)));
    const dossierFichier = lancer([join(dir, 'corpus'), join(dir, 'lecture.json')], dir);
    expect(dossierFichier.code).toBe(2);
    expect(dossierFichier.out).toBe('');
    expect(dossierFichier.err).toMatch(/combinaisons acceptées : deux fichiers .* ou deux dossiers .*reçu un dossier et un fichier/);
    const fichierDossier = lancer([join(dir, 'attendu.json'), join(dir, 'lectures')], dir);
    expect(fichierDossier.code).toBe(2);
    expect(fichierDossier.err).toMatch(/reçu un fichier et un dossier/);
    expect(lancer([join(dir, 'corpus'), join(dir, 'lectures')], dir).code).toBe(0);
  });
});
