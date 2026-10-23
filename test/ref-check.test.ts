import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';

type Obj = Record<string, any>;

const SHA = 'a'.repeat(64);
const ZONE = { x: 10, y: 20, l: 100, h: 40 };
const src = { page: 1, zone: ZONE };
const pct = { x: 0, y: 0, l: 50, h: 10 };

/** Un élément valide de chaque type, ids du slug « exemple ». */
const BASE: Record<string, Obj> = {
  ecran: { type: 'ecran', id: 'exemple#ecran-1', source: src, confiance: 'mesure', largeur_reference: 1440, zones: [{ nom: 'entete', ...ZONE, pct }] },
  composant: { type: 'composant', id: 'exemple#composant-1', source: src, confiance: 'mesure', role: 'bouton', position: { x: 1, y: 2 }, taille: { l: 3, h: 4 }, contenu: '', ecran: 'exemple#ecran-1' },
  etat: { type: 'etat', id: 'exemple#etat-1', source: src, confiance: 'lu', nom: 'vide', cible: 'exemple#composant-1' },
  texte: { type: 'texte', id: 'exemple#texte-1', source: src, confiance: 'lu', libelle: 'Valider', role: 'bouton' },
  jeton: { type: 'jeton', id: 'exemple#jeton-1', source: src, confiance: 'mesure', categorie: 'couleur', valeur: '#c81e28', point: { x: 5, y: 6 } },
  table: { type: 'table', id: 'exemple#table-1', source: src, confiance: 'lu', colonnes: ['a', 'b', 'c'], lignes: [['1', '2', '3']] },
  gabarit: { type: 'gabarit', id: 'exemple#gabarit-1', source: src, confiance: 'lu', nom: 'message', champs: [{ nom: 'date', obligatoire: true, format: 'AAAAMMJJ', min: 1, max: 8 }] },
  schema: { type: 'schema', id: 'exemple#schema-1', source: src, confiance: 'lu', noeuds: [{ id: 'a', libelle: 'A' }, { id: 'b', libelle: 'B' }], flux: [{ de: 'a', vers: 'b', libelle: 'envoie', direction: 'de_vers' }] },
  lien: { type: 'lien', id: 'exemple#lien-1', source: src, confiance: 'lu', figure: 'Figure 1', passage: { page: 1, ligne: 2, extrait: 'comme ci-dessous' }, constat: 'confirme' },
  statut: { type: 'statut', id: 'exemple#statut-1', source: src, confiance: 'lu', libelle: 'Proposal', couvre: ['exemple#ecran-1'] },
  silence: { type: 'silence', id: 'exemple#silence-1', source: { page: 2 }, confiance: 'incertain', cause: 'rien sur la page', question: 'Que se passe-t-il hors ligne ?' },
};
const TYPES = Object.keys(BASE);

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const doc = (elements: Obj[] = [BASE.texte!], extra: Obj = {}): Obj => ({ version: 1, genre: 'inventaire', document: { slug: 'exemple', sha256: SHA }, elements: clone(elements), ...extra });
/** Un élément de base de ce type, modifié par `edit`. */
const el = (type: string, edit: (e: Obj) => void = () => undefined): Obj => {
  const e = clone(BASE[type]!);
  edit(e);
  return e;
};

function check(content: string | undefined, env: NodeJS.ProcessEnv = {}) {
  const dir = tempDir();
  const file = join(dir, 'inv.json');
  if (content !== undefined) writeFileSync(file, content);
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['ref', 'check', file], { cwd: dir, env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-23T10:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n'), dir, file };
}
const checkDoc = (d: unknown, env: NodeJS.ProcessEnv = {}) => check(JSON.stringify(d), env);
/** Les écarts d'un document : le code est 1 et le texte contient les lignes. */
const ecarts = (d: unknown) => {
  const r = checkDoc(d);
  expect(r.err).toBe('');
  expect(r.code, r.out).toBe(1);
  return r.out;
};
const valide = (d: unknown) => {
  const r = checkDoc(d);
  expect(r.out + r.err).toMatch(/valide/);
  expect(r.code, r.out + r.err).toBe(0);
  return r;
};

describe('cadence ref check (L263)', () => {
  it('R1 — fichier valide : code 0', () => {
    expect(checkDoc(doc()).code).toBe(0);
  });
  it('R1 — fichier à écarts : code 1', () => {
    expect(checkDoc(doc([])).code).toBe(1);
  });
  it('R1 — fichier absent : code 2', () => {
    expect(check(undefined).code).toBe(2);
  });

  it('R2 — sans argument : usage et code 2', () => {
    const err: string[] = [];
    const code = run(['ref', 'check'], { cwd: tempDir(), env: {}, out: () => undefined, err: (l) => err.push(l), now: () => new Date() }) as number;
    expect(code).toBe(2);
    expect(err.join('\n')).toBe('raf: usage : cadence ref check <inventaire.json | lecture.json>');
  });
  it('R2 — deux arguments : usage et code 2', () => {
    const err: string[] = [];
    const code = run(['ref', 'check', 'a.json', 'b.json'], { cwd: tempDir(), env: {}, out: () => undefined, err: (l) => err.push(l), now: () => new Date() }) as number;
    expect(code).toBe(2);
    expect(err.join('\n')).toBe('raf: usage : cadence ref check <inventaire.json | lecture.json>');
  });

  it('R3 — fichier absent : code 2 et chemin nommé', () => {
    const r = check(undefined);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`raf: ref : fichier introuvable : ${r.file}`);
    expect(r.out).toBe('');
  });
  it('R3 — JSON invalide : code 2 et cause', () => {
    const r = check('{ "version": ');
    expect(r.code).toBe(2);
    expect(r.err).toContain(`ref : ${r.file} n'est pas du JSON lisible : `);
    expect(r.err.length).toBeGreaterThan(`ref : ${r.file} n'est pas du JSON lisible : `.length);
  });
  it('R3 — fichier vide : code 2 et chemin nommé', () => {
    const r = check('');
    expect(r.code).toBe(2);
    expect(r.err).toContain(`ref : ${r.file} n'est pas du JSON lisible`);
  });
  it('R3 — BOM UTF-8 : code 2', () => {
    const r = check('﻿' + JSON.stringify(doc()));
    expect(r.code).toBe(2);
    expect(r.err).toContain("n'est pas du JSON lisible");
  });
  it('R3 — chemin qui est un dossier : code 2', () => {
    const dir = tempDir();
    const dossier = join(dir, 'd.json');
    mkdirSync(dossier);
    const err: string[] = [];
    const code = run(['ref', 'check', dossier], { cwd: dir, env: {}, out: () => undefined, err: (l) => err.push(l), now: () => new Date() }) as number;
    expect(code).toBe(2);
    expect(err.join('\n')).toBe(`raf: ref : ${dossier} n'est pas un fichier lisible`);
  });
  it('R3 — clé dupliquée : acceptée, la dernière valeur est validée', () => {
    const json = JSON.stringify(doc()).replace('"version":1', '"version":2,"version":1');
    expect(json).toContain('"version":2,"version":1');
    expect(check(json).code).toBe(0);
    expect(check(JSON.stringify(doc()).replace('"version":1', '"version":1,"version":2')).code).toBe(1);
  });

  it('R4 — deux écarts : deux lignes ✗ puis « 2 écart(s) »', () => {
    const r = checkDoc(doc([BASE.texte!], { version: 2, genre: 'autre' }));
    expect(r.code).toBe(1);
    expect(r.out.split('\n')).toEqual(['✗ version : 1 attendu', '✗ genre : « inventaire » ou « lecture » attendu', '2 écart(s)']);
  });
  it('R4 — fichier valide : résumé avec le nombre d\'éléments par type', () => {
    const r = valide(doc([BASE.ecran!, BASE.composant!, BASE.texte!, el('texte', (e) => (e.id = 'exemple#texte-2'))]));
    expect(r.out).toBe('inventaire valide : 4 éléments (ecran: 1, composant: 1, texte: 2)');
  });
  it('R4 — écarts : lignes ✗ sur la sortie standard, rien sur la sortie d\'erreur', () => {
    const r = checkDoc(doc([]));
    expect(r.out).toMatch(/^✗ elements : /);
    expect(r.err).toBe('');
  });
  it('R4 — lecture valide : le résumé dit « lecture valide »', () => {
    expect(valide(doc([BASE.texte!], { genre: 'lecture' })).out).toBe('lecture valide : 1 éléments (texte: 1)');
  });

  it('R5 — racine tableau : écart, code 1', () => {
    const r = check('[]');
    expect(r.code).toBe(1);
    expect(r.out).toBe('✗ racine : un objet est attendu\n1 écart(s)');
  });
  it('R5 — racine chaîne : écart, code 1', () => {
    expect(check('"x"').out).toContain('✗ racine : un objet est attendu');
    expect(check('null').code).toBe(1);
    expect(check('3').code).toBe(1);
  });
  it('R5 — version 2 : écart', () => {
    expect(ecarts(doc([BASE.texte!], { version: 2 }))).toContain('✗ version : 1 attendu');
  });
  it('R5 — genre inconnu : écart', () => {
    expect(ecarts(doc([BASE.texte!], { genre: 'brouillon' }))).toContain('✗ genre : « inventaire » ou « lecture » attendu');
  });

  it('R6 — slug en majuscules : écart', () => {
    expect(ecarts(doc([BASE.texte!], { document: { slug: 'Exemple', sha256: SHA } }))).toContain('✗ document.slug : kebab-case attendu');
  });
  it('R6 — sha256 de 63 caractères : écart', () => {
    expect(ecarts(doc([BASE.texte!], { document: { slug: 'exemple', sha256: 'a'.repeat(63) } }))).toContain('✗ document.sha256 : 64 caractères hexadécimaux minuscules attendus');
    expect(ecarts(doc([BASE.texte!], { document: { slug: 'exemple', sha256: 'A'.repeat(64) } }))).toContain('document.sha256');
  });
  it('R6 — document absent : écart', () => {
    const d = doc();
    delete d.document;
    const out = ecarts(d);
    expect(out).toContain('✗ document.slug : kebab-case attendu');
    expect(out).toContain('✗ document.sha256 :');
  });

  it('R7 — elements vide : écart', () => {
    expect(ecarts(doc([]))).toContain('✗ elements : un tableau non vide est attendu');
  });
  it('R7 — elements absent : écart', () => {
    const d = doc();
    delete d.elements;
    expect(ecarts(d)).toContain('✗ elements : un tableau non vide est attendu');
  });
  it('R7 — elements objet : écart', () => {
    expect(ecarts(doc([], { elements: {} }))).toContain('✗ elements : un tableau non vide est attendu');
  });

  it('R8 — type « bouton » : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.type = 'bouton'))]))).toContain('✗ elements[0].type : l\'un des onze types attendu');
  });
  it('R8 — chacun des onze types est accepté', () => {
    const r = valide(doc(TYPES.map((t) => BASE[t]!)));
    expect(r.out).toBe(`inventaire valide : 11 éléments (${TYPES.map((t) => `${t}: 1`).join(', ')})`);
  });

  it('R9 — id d\'un autre slug : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.id = 'autre#texte-1'))]))).toContain('✗ elements[0].id : <slug>#<type>-<n> attendu');
  });
  it('R9 — id dont le type diffère de celui de l\'élément : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.id = 'exemple#jeton-1'))]))).toContain('elements[0].id');
  });
  it('R9 — n = 0 ou 01 : écart', () => {
    for (const id of ['exemple#texte-0', 'exemple#texte-01', 'exemple#texte-', 'exemple#texte-1a']) {
      expect(ecarts(doc([el('texte', (e) => (e.id = id))])), id).toContain('elements[0].id');
    }
    expect(checkDoc(doc([el('texte', (e) => (e.id = 'exemple#texte-10'))])).code).toBe(0);
  });
  it('R9 — slug de document invalide : écarts R6 et R9 listés', () => {
    const out = ecarts(doc([el('texte', (e) => (e.id = 'exemple#texte-1'))], { document: { slug: 'Exemple', sha256: SHA } }));
    expect(out).toContain('✗ document.slug : kebab-case attendu');
    expect(out).toContain('✗ elements[0].id : <slug>#<type>-<n> attendu');
  });

  it('R10 — deux éléments de même id : écart citant les deux positions', () => {
    const out = ecarts(doc([BASE.texte!, el('texte')]));
    expect(out).toContain('✗ elements[1].id : déjà porté par elements[0]');
  });

  it('R11 — page 0 : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.source.page = 0))]))).toContain('✗ elements[0].source.page : champ du type texte manquant ou invalide');
  });
  it('R11 — l négatif ou nul : écart', () => {
    for (const l of [0, -3]) expect(ecarts(doc([el('texte', (e) => (e.source.zone.l = l))])), String(l)).toContain('✗ elements[0].source.zone : x, y, l, h entiers attendus (l et h ≥ 1)');
    expect(ecarts(doc([el('texte', (e) => (e.source.zone.x = -1))]))).toContain('elements[0].source.zone');
  });
  it('R11 — zone décimale : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.source.zone.h = 4.5))]))).toContain('elements[0].source.zone');
  });
  it('R11 — zone absente sur un composant : écart', () => {
    expect(ecarts(doc([el('composant', (e) => delete e.source.zone)]))).toContain('✗ elements[0].source.zone : x, y, l, h entiers attendus (l et h ≥ 1)');
  });

  it('R12 — extrait vide : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.citations = [{ page: 1, ligne: 2, extrait: '' }]))]))).toContain('✗ elements[0].citations[0].extrait : champ du type texte manquant ou invalide');
    valide(doc([el('texte', (e) => (e.citations = [{ page: 1, ligne: 2, extrait: 'x' }]))]));
  });
  it('R11 — source ou élément qui n\'est pas un objet : écarts du contrat', () => {
    const out = ecarts(doc([el('texte', (e) => (e.source = 'x'))]));
    expect(out).toContain('✗ elements[0].source.zone : x, y, l, h entiers attendus (l et h ≥ 1)');
    expect(out).toContain('✗ elements[0].source.page : champ du type texte manquant ou invalide');
    expect(ecarts(doc([BASE.texte!, 'x' as any]))).toContain('✗ elements[1].type : l\'un des onze types attendu');
  });
  it('R12 — ligne manquante : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.citations = [{ page: 1, extrait: 'x' }]))]))).toContain('✗ elements[0].citations[0].ligne : champ du type texte manquant ou invalide');
  });

  it('R13 — confiance « sûr » : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.confiance = 'sûr'))]))).toContain('✗ elements[0].confiance : mesure, lu ou incertain attendu');
  });
  it('R13 — confiance absente : écart', () => {
    expect(ecarts(doc([el('texte', (e) => delete e.confiance)]))).toContain('✗ elements[0].confiance : mesure, lu ou incertain attendu');
  });

  it('R14 — incertain sans cause : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.confiance = 'incertain'))]))).toContain('✗ elements[0].cause : obligatoire pour un élément incertain');
    expect(ecarts(doc([el('texte', (e) => { e.confiance = 'incertain'; e.cause = '  '; })]))).toContain('elements[0].cause');
  });
  it('R14 — lu avec une cause : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.cause = 'x'))]))).toContain('✗ elements[0].cause : champ du type texte manquant ou invalide');
    expect(ecarts(doc([el('jeton', (e) => (e.cause = 'x'))]))).toContain('✗ elements[0].cause : champ du type jeton manquant ou invalide');
    valide(doc([el('texte', (e) => { e.confiance = 'incertain'; e.cause = 'flou'; })]));
  });

  it('R15 — ocr « oui » : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.ocr = 'oui'))]))).toContain('✗ elements[0].ocr : champ du type texte manquant ou invalide');
  });
  it('R15 — lecture, ocr true et lu : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.ocr = true))], { genre: 'lecture' }))).toContain('✗ elements[0].confiance : un texte ocr n\'est jamais lu dans une lecture');
    valide(doc([el('texte', (e) => { e.ocr = true; e.confiance = 'mesure'; })], { genre: 'lecture' }));
  });
  it('R15 — inventaire, ocr true et lu : accepté', () => {
    valide(doc([el('texte', (e) => (e.ocr = true))]));
  });

  it('R16 — largeur 0 : écart', () => {
    expect(ecarts(doc([el('ecran', (e) => (e.largeur_reference = 0))]))).toContain('✗ elements[0].largeur_reference : champ du type ecran manquant ou invalide');
  });
  it('R16 — zones vide : écart', () => {
    expect(ecarts(doc([el('ecran', (e) => (e.zones = []))]))).toContain('✗ elements[0].zones : champ du type ecran manquant ou invalide');
  });
  it('R16 — pct.l = 120 : écart', () => {
    expect(ecarts(doc([el('ecran', (e) => (e.zones[0].pct.l = 120))]))).toContain('✗ elements[0].zones[0].pct.l : champ du type ecran manquant ou invalide');
  });

  it('R17 — role vide : écart', () => {
    expect(ecarts(doc([BASE.ecran!, el('composant', (e) => (e.role = ''))]))).toContain('✗ elements[1].role : champ du type composant manquant ou invalide');
  });
  it('R17 — taille.h = 0 : écart', () => {
    expect(ecarts(doc([BASE.ecran!, el('composant', (e) => (e.taille.h = 0))]))).toContain('✗ elements[1].taille.h : champ du type composant manquant ou invalide');
    expect(ecarts(doc([BASE.ecran!, el('composant', (e) => (e.position.x = -1))]))).toContain('elements[1].position.x');
    expect(ecarts(doc([BASE.ecran!, el('composant', (e) => (e.position.y = '2'))]))).toContain('elements[1].position.y');
  });
  it('R17 — ecran absent : écart', () => {
    expect(ecarts(doc([BASE.ecran!, el('composant', (e) => delete e.ecran)]))).toContain('✗ elements[1].ecran : champ du type composant manquant ou invalide');
  });

  it('R18 — nom vide : écart', () => {
    expect(ecarts(doc([BASE.ecran!, BASE.composant!, el('etat', (e) => (e.nom = ''))]))).toContain('✗ elements[2].nom : champ du type etat manquant ou invalide');
  });
  it('R18 — cible absente : écart', () => {
    expect(ecarts(doc([BASE.ecran!, BASE.composant!, el('etat', (e) => delete e.cible)]))).toContain('✗ elements[2].cible : champ du type etat manquant ou invalide');
  });
  it('R18 — nom « hors_ligne » (hors liste citée) : accepté', () => {
    valide(doc([BASE.ecran!, BASE.composant!, el('etat', (e) => (e.nom = 'hors_ligne'))]));
  });

  it('R19 — libelle vide : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.libelle = ''))]))).toContain('✗ elements[0].libelle : champ du type texte manquant ou invalide');
  });
  it('R19 — role absent : écart', () => {
    expect(ecarts(doc([el('texte', (e) => delete e.role)]))).toContain('✗ elements[0].role : champ du type texte manquant ou invalide');
  });

  it('R20 — categorie « ombre » : écart', () => {
    expect(ecarts(doc([el('jeton', (e) => (e.categorie = 'ombre'))]))).toContain('✗ elements[0].categorie : champ du type jeton manquant ou invalide');
  });
  it('R20 — jeton mesure sans point : écart', () => {
    expect(ecarts(doc([el('jeton', (e) => delete e.point)]))).toContain('✗ elements[0].point : champ du type jeton manquant ou invalide');
    valide(doc([el('jeton', (e) => (e.point = { x: 1, y: 2, l: 3, h: 4 }))]));
    expect(ecarts(doc([el('jeton', (e) => (e.point = { x: 1, y: -2 }))]))).toContain('elements[0].point');
  });
  it('R20 — ratio 22 : écart', () => {
    expect(ecarts(doc([el('jeton', (e) => (e.contraste = { texte: '#000', fond: '#fff', ratio: 22 }))]))).toContain('✗ elements[0].contraste.ratio : champ du type jeton manquant ou invalide');
    valide(doc([el('jeton', (e) => (e.contraste = { texte: '#000', fond: '#fff', ratio: 21 }))]));
    expect(ecarts(doc([el('jeton', (e) => (e.contraste = { texte: '#000', fond: '#fff', ratio: 0.5 }))]))).toContain('contraste.ratio');
  });
  it('R20 — jeton lu sans point : accepté', () => {
    valide(doc([el('jeton', (e) => { e.confiance = 'lu'; delete e.point; })]));
    valide(doc([el('jeton', (e) => { e.confiance = 'lu'; e.valeur = 16; delete e.point; })]));
    expect(ecarts(doc([el('jeton', (e) => (e.valeur = ''))]))).toContain('elements[0].valeur');
    expect(ecarts(doc([el('jeton', (e) => (e.valeur = null))]))).toContain('elements[0].valeur');
  });

  it('R21 — ligne de deux cellules pour trois colonnes : écart citant la ligne', () => {
    expect(ecarts(doc([el('table', (e) => (e.lignes = [['1', '2', '3'], ['1', '2']]))]))).toContain('✗ elements[0].lignes[1] : champ du type table manquant ou invalide');
  });
  it('R21 — lignes vide : écart', () => {
    expect(ecarts(doc([el('table', (e) => (e.lignes = []))]))).toContain('✗ elements[0].lignes : champ du type table manquant ou invalide');
    expect(ecarts(doc([el('table', (e) => (e.colonnes = []))]))).toContain('elements[0].colonnes');
  });

  it('R22 — min 5, max 2 : écart', () => {
    expect(ecarts(doc([el('gabarit', (e) => { e.champs[0].min = 5; e.champs[0].max = 2; })]))).toContain('✗ elements[0].champs[0].min : champ du type gabarit manquant ou invalide');
  });
  it('R22 — obligatoire « oui » : écart', () => {
    expect(ecarts(doc([el('gabarit', (e) => (e.champs[0].obligatoire = 'oui'))]))).toContain('✗ elements[0].champs[0].obligatoire : champ du type gabarit manquant ou invalide');
  });
  it('R22 — champs vide : écart', () => {
    expect(ecarts(doc([el('gabarit', (e) => (e.champs = []))]))).toContain('✗ elements[0].champs : champ du type gabarit manquant ou invalide');
  });
  it('R22 — champ sans bornes : accepté', () => {
    valide(doc([el('gabarit', (e) => { delete e.champs[0].min; delete e.champs[0].max; })]));
  });

  it('R23 — flux vers un nœud absent : écart', () => {
    expect(ecarts(doc([el('schema', (e) => (e.flux[0].vers = 'z'))]))).toContain('✗ elements[0].flux[0].vers : z ne désigne aucun élément de type noeud');
  });
  it('R23 — deux nœuds de même id : écart', () => {
    expect(ecarts(doc([el('schema', (e) => (e.noeuds[1].id = 'a'))]))).toContain('✗ elements[0].noeuds[1].id : champ du type schema manquant ou invalide');
  });
  it('R23 — flux vide : accepté', () => {
    valide(doc([el('schema', (e) => (e.flux = []))]));
    expect(ecarts(doc([el('schema', (e) => (e.noeuds = []))]))).toContain('elements[0].noeuds');
  });

  it('R24 — constat « peut-être » : écart', () => {
    expect(ecarts(doc([el('lien', (e) => (e.constat = 'peut-être'))]))).toContain('✗ elements[0].constat : champ du type lien manquant ou invalide');
  });
  it('R24 — precise sans raison : écart', () => {
    const precise = (e: Obj) => Object.assign(e, { constat: 'precise', lecture_ambigue: 'a', interpretation: 'b', raison: 'c' });
    valide(doc([el('lien', precise)]));
    expect(ecarts(doc([el('lien', (e) => { precise(e); delete e.raison; })]))).toContain('✗ elements[0].raison : champ du type lien manquant ou invalide');
    expect(ecarts(doc([el('lien', (e) => { precise(e); e.interpretation = ''; })]))).toContain('elements[0].interpretation');
  });
  it('R24 — contredit avec un seul énoncé : écart', () => {
    const contredit = (e: Obj) => Object.assign(e, { constat: 'contredit', enonces: ['a', 'b'] });
    valide(doc([el('lien', contredit)]));
    expect(ecarts(doc([el('lien', (e) => { contredit(e); e.enonces = ['a']; })]))).toContain('✗ elements[0].enonces : champ du type lien manquant ou invalide');
  });
  it('R24 — contredit avec interpretation : écart', () => {
    expect(ecarts(doc([el('lien', (e) => Object.assign(e, { constat: 'contredit', enonces: ['a', 'b'], interpretation: 'je tranche' }))]))).toContain('✗ elements[0].interpretation : un lien contredit ne tranche pas');
  });
  it('R24 — confirme avec figure et passage : accepté', () => {
    valide(doc([BASE.lien!]));
    expect(ecarts(doc([el('lien', (e) => delete e.passage.ligne)]))).toContain('elements[0].passage.ligne');
    expect(ecarts(doc([el('lien', (e) => (e.figure = ''))]))).toContain('elements[0].figure');
  });

  it('R25 — couvre vide : écart', () => {
    expect(ecarts(doc([el('statut', (e) => (e.couvre = []))]))).toContain('✗ elements[0].couvre : champ du type statut manquant ou invalide');
  });
  it('R25 — libelle vide : écart', () => {
    expect(ecarts(doc([BASE.ecran!, el('statut', (e) => (e.libelle = ''))]))).toContain('✗ elements[1].libelle : champ du type statut manquant ou invalide');
  });

  it('R26 — question vide : écart', () => {
    expect(ecarts(doc([el('silence', (e) => (e.question = ''))]))).toContain('✗ elements[0].question : champ du type silence manquant ou invalide');
  });

  it('R27 — composant dont l\'ecran est un texte : écart', () => {
    expect(ecarts(doc([BASE.texte!, el('composant', (e) => (e.ecran = 'exemple#texte-1'))]))).toContain('✗ elements[1].ecran : exemple#texte-1 ne désigne aucun élément de type ecran');
  });
  it('R27 — etat dont la cible n\'existe pas : écart', () => {
    expect(ecarts(doc([el('etat', (e) => (e.cible = 'exemple#composant-9'))]))).toContain('✗ elements[0].cible : exemple#composant-9 ne désigne aucun élément de type composant ou ecran');
    expect(ecarts(doc([BASE.texte!, el('etat', (e) => (e.cible = 'exemple#texte-1'))]))).toContain('elements[1].cible');
  });
  it('R27 — statut qui couvre un id absent : écart', () => {
    expect(ecarts(doc([el('statut', (e) => (e.couvre = ['exemple#ecran-9']))]))).toContain('✗ elements[0].couvre[0] : exemple#ecran-9 ne désigne aucun élément de type ecran, composant, etat, texte, jeton, table, gabarit, schema, lien, statut ou silence');
  });
  it('R27 — statut qui se couvre lui-même : accepté', () => {
    valide(doc([el('statut', (e) => (e.couvre = ['exemple#statut-1']))]));
  });
  it("R27 — statut qui couvre un élément dont le type est absent : pas d'écart de référence", () => {
    const sansType = el('texte', (e) => delete e.type);
    const lignes = ecarts(doc([sansType, el('statut', (e) => (e.couvre = [sansType.id]))]));
    expect(lignes).toContain('elements[0].type');
    expect(lignes).not.toContain('couvre');
  });
  it('R27 — référence vers un élément placé plus loin dans la liste : acceptée', () => {
    valide(doc([BASE.composant!, BASE.ecran!]));
  });

  it('R28 — clé « couleur » sur un texte valide : code 0', () => {
    valide(doc([el('texte', (e) => (e.couleur = 'rouge'))]));
  });
  it('R28 — clé inconnue à la racine : code 0', () => {
    valide(doc([BASE.texte!], { agent: 'reference-analyst' }));
  });

  it('R29 — ref check sur templates/inventaire.json : code 0', () => {
    const r = check(readFileSync(join(import.meta.dirname, '..', 'templates', 'inventaire.json'), 'utf8'));
    expect(r.err).toBe('');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^inventaire valide : /);
  });
  it('R29 — le modèle porte les onze types', () => {
    const modele = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'templates', 'inventaire.json'), 'utf8'));
    const types = new Set(modele.elements.map((e: Obj) => e.type));
    expect([...types].sort()).toEqual([...TYPES].sort());
    expect(modele.document.slug).toBe('exemple');
  });

  it('R30 — PATH vide : check fonctionne et sort 0', () => {
    const r = check(JSON.stringify(doc()), { PATH: '' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });
  it('R30 — le dossier du fichier est inchangé après l\'appel', () => {
    const dir = tempDir();
    const file = join(dir, 'inv.json');
    writeFileSync(file, JSON.stringify(doc()));
    const avant = readdirSync(dir);
    const contenu = readFileSync(file, 'utf8');
    const code = run(['ref', 'check', file], { cwd: dir, env: {}, out: () => undefined, err: () => undefined, now: () => new Date() }) as number;
    expect(code).toBe(0);
    expect(readdirSync(dir)).toEqual(avant);
    expect(readFileSync(file, 'utf8')).toBe(contenu);
  });

  it('R31 — zone absente sur un silence : accepté', () => {
    valide(doc([BASE.silence!]));
    expect(ecarts(doc([el('silence', (e) => (e.source.zone = { x: 1, y: 1, l: 0, h: 1 }))]))).toContain('elements[0].source.zone');
  });
  it('R31 — zone absente sur un texte : écart', () => {
    expect(ecarts(doc([el('texte', (e) => delete e.source.zone)]))).toContain('elements[0].source.zone');
  });

  it('R32 — largeur_reference 0 : écart', () => {
    expect(ecarts(doc([el('ecran', (e) => (e.largeur_reference = 0))]))).toContain('elements[0].largeur_reference');
    expect(ecarts(doc([el('ecran', (e) => (e.largeur_reference = 14.5))]))).toContain('elements[0].largeur_reference');
  });
  it('R32 — zones vide : écart', () => {
    expect(ecarts(doc([el('ecran', (e) => delete e.zones)]))).toContain('elements[0].zones');
  });
  it('R32 — pct.l = 120 : écart', () => {
    expect(ecarts(doc([el('ecran', (e) => (e.zones[0].pct.l = 120))]))).toContain('elements[0].zones[0].pct.l');
    valide(doc([el('ecran', (e) => (e.zones[0].pct = { x: 0, y: 12.5, l: 100, h: 0 }))]));
  });
  it('R32 — zone sans pct : écart', () => {
    expect(ecarts(doc([el('ecran', (e) => delete e.zones[0].pct)]))).toContain('✗ elements[0].zones[0].pct : champ du type ecran manquant ou invalide');
    expect(ecarts(doc([el('ecran', (e) => (e.zones[0].l = 0))]))).toContain('elements[0].zones[0].l');
  });

  it('R33 — libelle « Valider » (blanc en fin) : écart', () => {
    expect(ecarts(doc([el('texte', (e) => (e.libelle = 'Valider '))]))).toContain('✗ elements[0].libelle : champ du type texte manquant ou invalide');
    expect(ecarts(doc([el('texte', (e) => (e.libelle = ' Valider'))]))).toContain('elements[0].libelle');
  });
  it('R33 — libelle « Valider » sans blanc : accepté', () => {
    valide(doc([BASE.texte!]));
  });

  it('R34 — direction « haut » : écart', () => {
    expect(ecarts(doc([el('schema', (e) => (e.flux[0].direction = 'haut'))]))).toContain('✗ elements[0].flux[0].direction : champ du type schema manquant ou invalide');
  });
  it('R34 — « de_vers » et « bidirectionnel » : acceptées', () => {
    valide(doc([el('schema', (e) => e.flux.push({ de: 'b', vers: 'a', libelle: 'retour', direction: 'bidirectionnel' }))]));
  });

  it('R35 — question sans point d\'interrogation : écart', () => {
    expect(ecarts(doc([el('silence', (e) => (e.question = 'Que faire'))]))).toContain('✗ elements[0].question : champ du type silence manquant ou invalide');
  });
  it('R35 — question terminée par « ? » : acceptée', () => {
    valide(doc([el('silence', (e) => (e.question = 'Que faire ?  '))]));
  });

  it('tous les écarts sont listés, dans l\'ordre des éléments', () => {
    const out = ecarts(doc([el('texte', (e) => (e.libelle = '')), el('texte', (e) => { e.id = 'exemple#texte-2'; e.role = ''; })]));
    expect(out.split('\n')).toEqual(['✗ elements[0].libelle : champ du type texte manquant ou invalide', '✗ elements[1].role : champ du type texte manquant ou invalide', '2 écart(s)']);
  });
});
