import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { checkInventaire } from '../src/ref/check.js';
import { assembler, reconcilier, SEUIL_NON_APPARIES, type Decision } from '../src/ref/diff.js';
import { tempDir } from './helpers.js';

type Obj = Record<string, any>;

const SHA = 'a'.repeat(64);
const zone = (x: number, y = 100, l = 200, h = 40) => ({ x, y, l, h });

const texte = (n: number, libelle: string, x: number, o: Obj = {}): Obj => ({ type: 'texte', id: `doc#texte-${n}`, confiance: 'lu', source: { page: 1, zone: zone(x) }, libelle, role: 'titre', ...o });
const ecran = (n: number, o: Obj = {}): Obj => ({ type: 'ecran', id: `doc#ecran-${n}`, confiance: 'mesure', source: { page: 1, zone: { x: 0, y: 0, l: 1700, h: 2200 } }, largeur_reference: 1440, zones: [{ nom: 'tout', x: 0, y: 0, l: 1440, h: 900, pct: { x: 0, y: 0, l: 100, h: 100 } }], ...o });
const composant = (n: number, contenu: string, x: number, ecranId: string, o: Obj = {}): Obj => ({ type: 'composant', id: `doc#composant-${n}`, confiance: 'lu', source: { page: 1, zone: zone(x) }, role: 'bouton', position: { x, y: 100 }, taille: { l: 200, h: 40 }, contenu, ecran: ecranId, ...o });
const lien = (n: number, constat: string, o: Obj = {}): Obj => ({ type: 'lien', id: `doc#lien-${n}`, confiance: 'lu', source: { page: 1, zone: zone(600, 600, 300, 200) }, figure: 'Figure 1 — chaîne', passage: { page: 1, ligne: 3, extrait: 'voir la figure' }, constat, ...(constat === 'contredit' ? { enonces: ['80 kt', '100 kt'] } : {}), ...o });
const silence = (n: number, question: string): Obj => ({ type: 'silence', id: `doc#silence-${n}`, confiance: 'incertain', source: { page: 1 }, cause: 'non montré', question });
const jeton = (n: number, valeur: string, o: Obj = {}): Obj => ({ type: 'jeton', id: `doc#jeton-${n}`, confiance: 'mesure', source: { page: 1, zone: zone(900) }, categorie: 'couleur', valeur, point: { x: 910, y: 110 }, ...o });
const etat = (n: number, cible: string): Obj => ({ type: 'etat', id: `doc#etat-${n}`, confiance: 'lu', source: { page: 1, zone: zone(300) }, nom: 'desactive', cible });
const statut = (n: number, couvre: string[]): Obj => ({ type: 'statut', id: `doc#statut-${n}`, confiance: 'lu', source: { page: 1, zone: zone(1400, 20, 200, 40) }, libelle: 'Proposal', couvre });

const lecture = (elements: Obj[], o: Obj = {}): Obj => ({ version: 1, genre: 'lecture', document: { slug: 'doc', sha256: SHA }, elements, ...o });

const ids = (inv: Obj): string[] => inv.elements.map((e: Obj) => e.id);

describe('cadence ref diff : réconciliation de deux lectures (L266)', () => {
  it('R1 — un élément lu dans les deux lectures est concordant : un seul élément lu, ids renumérotés', () => {
    const a = lecture([texte(1, 'Layers', 100), texte(2, 'Wind', 400)]);
    const b = lecture([texte(7, 'Wind', 402), texte(9, 'Layers', 101)]);
    const rec = reconcilier(a, b);
    expect(rec.concordants).toBe(2);
    expect(rec.divergents).toBe(0);
    expect(rec.seuls).toBe(0);
    const inv = assembler(a, b, rec);
    expect(inv.genre).toBe('inventaire');
    expect(inv.elements.map((e: Obj) => [e.id, e.libelle, e.confiance])).toEqual([['doc#texte-1', 'Layers', 'lu'], ['doc#texte-2', 'Wind', 'lu']]);
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R2 — deux mesures concordantes restent mesure, une mesure confirmée par une lecture est mesure ; un texte lu par les deux reste lu', () => {
    const a = lecture([jeton(1, '#1e3a8a'), jeton(2, '#ffffff', { source: { page: 1, zone: zone(1000) }, point: { x: 1010, y: 110 } })]);
    const b = lecture([jeton(5, '#1e3a8a'), jeton(6, '#ffffff', { confiance: 'lu', source: { page: 1, zone: zone(1000) }, point: undefined })]);
    const inv = assembler(a, b, reconcilier(a, b));
    expect(inv.elements.map((e: Obj) => e.confiance)).toEqual(['mesure', 'mesure']);
  });

  it('R3 — même élément, affirmation différente (un lien confirme d\'un côté, contredit de l\'autre) : incertain, les deux versions dans la cause', () => {
    const a = lecture([lien(1, 'confirme')]);
    const b = lecture([lien(1, 'contredit')]);
    const rec = reconcilier(a, b);
    expect(rec.divergents).toBe(1);
    const inv = assembler(a, b, rec);
    const e = inv.elements[0];
    expect(e.confiance).toBe('incertain');
    expect(e.cause).toContain('lectures divergentes');
    expect(e.cause).toContain('constat');
    expect(e.cause).toContain('confirme');
    expect(e.cause).toContain('contredit');
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R4 — même zone mais libellé lu différemment (120 KT / 120 kt) : divergent, jamais choisi, les deux libellés dans la cause', () => {
    const a = lecture([texte(1, '120 KT', 100)]);
    const b = lecture([texte(1, '120 kt', 110)]);
    const rec = reconcilier(a, b);
    expect(rec.divergents).toBe(1);
    expect(rec.seuls).toBe(0);
    const e = assembler(a, b, rec).elements[0];
    expect(e.confiance).toBe('incertain');
    expect(e.cause).toContain('120 KT');
    expect(e.cause).toContain('120 kt');
  });

  it('R5 — un élément d\'une seule lecture est « seul » : incertain, avec la lecture qui le porte, tant que le troisième regard n\'a pas eu lieu', () => {
    const a = lecture([texte(1, 'Layers', 100), texte(2, 'Wind', 400), texte(3, 'Waves', 700), texte(4, 'Tides', 1000)]);
    const b = lecture([texte(1, 'Layers', 100), texte(2, 'Wind', 400), texte(3, 'Waves', 700), texte(4, 'Tides', 1000), texte(5, 'Extra', 1300)]);
    const rec = reconcilier(a, b);
    expect(rec.seuls).toBe(1);
    expect(rec.items.find((i) => i.statut === 'seul')!.lecture).toBe('b');
    const e = assembler(a, b, rec).elements.find((x: Obj) => x.libelle === 'Extra')!;
    expect(e.confiance).toBe('incertain');
    expect(e.cause).toMatch(/lecture B seulement/);
    expect(e.cause).toMatch(/troisième regard/);
  });

  it('R6 — plus de 30 % d\'éléments non appariés : pas de réconciliation ; 30 % pile passe ; le seuil se règle', () => {
    expect(SEUIL_NON_APPARIES).toBe(0.3);
    const commun = [texte(1, 'A1', 100), texte(2, 'A2', 400), texte(3, 'A3', 700), texte(4, 'A4', 1000), texte(5, 'A5', 1300), texte(6, 'A6', 1600, { source: { page: 1, zone: zone(1600) } }), texte(7, 'A7', 100, { source: { page: 2, zone: zone(100) } })];
    // 7 communs + 3 seuls de B = 10 éléments distincts, 3 non appariés : 30 %
    const a = lecture(commun);
    const b = lecture([...commun.map((e, i) => ({ ...e, id: `doc#texte-${i + 1}` })), texte(8, 'B1', 100, { source: { page: 3, zone: zone(100) } }), texte(9, 'B2', 100, { source: { page: 4, zone: zone(100) } }), texte(10, 'B3', 100, { source: { page: 5, zone: zone(100) } })]);
    const rec = reconcilier(a, b);
    expect(rec.nonApparies).toBe(3);
    expect(rec.ratio).toBeCloseTo(0.3);
    expect(rec.refuse).toBe(false);
    expect(reconcilier(a, b, 0.2).refuse).toBe(true);
    // un de plus : 4 sur 11
    const b2 = lecture([...b.elements, texte(11, 'B4', 100, { source: { page: 6, zone: zone(100) } })]);
    expect(reconcilier(a, b2).refuse).toBe(true);
  });

  it('R7 — les silences sont réunis sans troisième regard et ne comptent pas dans les non appariés ; une même question n\'est écrite qu\'une fois', () => {
    const a = lecture([texte(1, 'Layers', 100), silence(1, 'Que voit-on en erreur ?'), silence(2, 'Quel état vide ?')]);
    const b = lecture([texte(1, 'Layers', 100), silence(1, 'Que voit-on en erreur ?'), silence(2, 'Quelle largeur mobile ?')]);
    const rec = reconcilier(a, b);
    expect(rec.seuls).toBe(0);
    expect(rec.nonApparies).toBe(0);
    const inv = assembler(a, b, rec);
    expect(inv.elements.filter((e: Obj) => e.type === 'silence').map((e: Obj) => e.question)).toEqual(['Que voit-on en erreur ?', 'Quel état vide ?', 'Quelle largeur mobile ?']);
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R8 — les références (composant.ecran, etat.cible, statut.couvre) suivent la renumérotation, y compris celles d\'un élément de la lecture B seule', () => {
    const a = lecture([ecran(1), composant(2, 'Layers', 100, 'doc#ecran-1')]);
    // B numérote autrement : l'écran est le n° 4, le composant Layers le n° 3 ; l'état et le statut sont propres à B
    const b = lecture([composant(3, 'Layers', 100, 'doc#ecran-4'), ecran(4), etat(1, 'doc#composant-3'), statut(1, ['doc#ecran-4', 'doc#composant-3'])]);
    const rec = reconcilier(a, b, 1);
    const inv = assembler(a, b, rec);
    expect(checkInventaire(inv)).toEqual([]);
    const parId = new Map<string, Obj>(inv.elements.map((e: Obj) => [e.id, e]));
    const e = inv.elements.find((x: Obj) => x.type === 'etat')!;
    expect(parId.get(e.cible)!.contenu).toBe('Layers');
    const s = inv.elements.find((x: Obj) => x.type === 'statut')!;
    expect(s.couvre.map((id: string) => parId.get(id)!.type).sort()).toEqual(['composant', 'ecran']);
  });

  it('R9 — le troisième regard : confirmé passe lu (mesure reste mesure, un doute reste un doute) ; écarté disparaît avec ses dépendants', () => {
    const a = lecture([ecran(1), composant(2, 'Layers', 100, 'doc#ecran-1'), jeton(3, '#123456')]);
    const b = lecture([ecran(1), composant(2, 'Layers', 100, 'doc#ecran-1'), texte(3, 'Seul', 500), texte(4, 'Fantôme', 800), etat(1, 'doc#composant-2')]);
    const rec = reconcilier(a, b, 1);
    const seuls = rec.items.filter((i) => i.statut === 'seul');
    expect(seuls.map((i) => i.element.libelle ?? i.element.valeur ?? i.element.nom)).toEqual(['#123456', 'Seul', 'Fantôme', 'desactive']);
    const decision = (verdict: Decision['verdict'], raison: string): Decision => ({ verdict, raison });
    seuls[0]!.decision = decision('confirme', 'la couleur est celle du bouton');
    seuls[1]!.decision = decision('confirme', 'écrit tel quel');
    seuls[2]!.decision = decision('ecarte', 'rien de tel dans la découpe');
    seuls[3]!.decision = decision('confirme', 'grisé');
    const inv = assembler(a, b, rec);
    expect(inv.elements.map((e: Obj) => e.libelle ?? e.valeur ?? e.nom ?? e.contenu ?? e.type)).toEqual(['ecran', 'Layers', '#123456', 'Seul', 'desactive']);
    expect(inv.elements.find((e: Obj) => e.valeur === '#123456').confiance).toBe('mesure');
    expect(inv.elements.find((e: Obj) => e.libelle === 'Seul').confiance).toBe('lu');
    expect(inv.elements.find((e: Obj) => e.libelle === 'Fantôme')).toBeUndefined();
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R10 — écarter la cible d\'un état écarte l\'état, retirer un élément d\'un statut le laisse couvrir les autres, et un statut qui ne couvre plus rien disparaît', () => {
    const a = lecture([ecran(1)]);
    const b = lecture([ecran(1), composant(2, 'Fantôme', 500, 'doc#ecran-1'), etat(1, 'doc#composant-2'), statut(1, ['doc#composant-2']), statut(2, ['doc#composant-2', 'doc#ecran-1'])]);
    const rec = reconcilier(a, b, 1);
    for (const i of rec.items.filter((x) => x.statut === 'seul' && x.element.type === 'composant')) i.decision = { verdict: 'ecarte', raison: 'absent' };
    for (const i of rec.items.filter((x) => x.statut === 'seul' && x.element.type !== 'composant')) i.decision = { verdict: 'confirme', raison: 'lu' };
    const inv = assembler(a, b, rec);
    expect(inv.elements.map((e: Obj) => e.type)).toEqual(['ecran', 'statut']);
    expect(inv.elements[1].couvre).toEqual([inv.elements[0].id]);
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R11 — un seul sans décision (le troisième regard n\'a rien dit) reste incertain, ce n\'est jamais un lu', () => {
    const a = lecture([texte(1, 'Layers', 100)]);
    const b = lecture([texte(1, 'Layers', 100), texte(2, 'Seul', 500)]);
    const rec = reconcilier(a, b, 1);
    const e = assembler(a, b, rec).elements.find((x: Obj) => x.libelle === 'Seul')!;
    expect(e.confiance).toBe('incertain');
  });

  it('R12 — concordants : l\'un des deux douteux rend l\'élément incertain, avec la cause du doute', () => {
    const a = lecture([texte(1, 'Layers', 100, { confiance: 'incertain', cause: 'flou' })]);
    const b = lecture([texte(1, 'Layers', 100)]);
    const e = assembler(a, b, reconcilier(a, b)).elements[0];
    expect(e.confiance).toBe('incertain');
    expect(e.cause).toBe('flou');
  });

  it('R9 bis — un seul incertain confirmé par le troisième regard garde son doute et sa cause : un doute reste un doute', () => {
    const a = lecture([texte(1, 'Layers', 100)]);
    const b = lecture([texte(1, 'Layers', 100), texte(2, 'Doute', 500, { confiance: 'incertain', cause: 'texte flou' })]);
    const rec = reconcilier(a, b, 1);
    rec.items.filter((i) => i.statut === 'seul')[0]!.decision = { verdict: 'confirme', raison: 'lisible sur la découpe' };
    const e = assembler(a, b, rec, true).elements.find((x: Obj) => x.libelle === 'Doute')!;
    expect(e.confiance).toBe('incertain');
    expect(e.cause).toBe('texte flou');
  });

  it('R16 — un concordant dont la version A renvoie à un écran écarté reste, rattaché d\'après la version B : incertain, avec la cause du rattachement (l\'identité d\'un composant ignore son écran)', () => {
    const petit = { source: { page: 1, zone: { x: 0, y: 0, l: 800, h: 600 } } };
    // A découpe un second écran à tort et y rattache le composant ; B le rattache à l'écran 1, que les deux lectures portent
    const a = lecture([ecran(1), ecran(2, petit), composant(3, 'Layers', 100, 'doc#ecran-2')]);
    const b = lecture([ecran(1), composant(2, 'Layers', 100, 'doc#ecran-1')]);
    const rec = reconcilier(a, b, 1);
    expect(rec.items.map((i) => i.statut)).toEqual(['concordant', 'seul', 'concordant']);
    const seul = rec.items.find((i) => i.statut === 'seul')!;
    expect(seul.element.type).toBe('ecran');
    seul.decision = { verdict: 'ecarte', raison: 'un seul écran dessiné' };
    const inv = assembler(a, b, rec, true);
    expect(inv.elements.map((e: Obj) => e.type)).toEqual(['ecran', 'composant']);
    const [ec, co] = inv.elements as Obj[];
    expect(co.ecran).toBe(ec!.id);
    expect(co.confiance).toBe('incertain');
    expect(co.cause).toMatch(/lecture A.*écarté.*lecture B/);
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R17 — le même cas côté B : la version B renvoie à l\'écran écarté, l\'élément reste, rattaché d\'après la version A, avec sa cause', () => {
    const petit = { source: { page: 1, zone: { x: 0, y: 0, l: 800, h: 600 } } };
    const a = lecture([ecran(1), composant(2, 'Layers', 100, 'doc#ecran-1')]);
    const b = lecture([ecran(1), ecran(2, petit), composant(3, 'Layers', 100, 'doc#ecran-2')]);
    const rec = reconcilier(a, b, 1);
    rec.items.find((i) => i.statut === 'seul')!.decision = { verdict: 'ecarte', raison: 'un seul écran dessiné' };
    const inv = assembler(a, b, rec, true);
    const co = inv.elements.find((e: Obj) => e.type === 'composant')!;
    expect(co.ecran).toBe(inv.elements.find((e: Obj) => e.type === 'ecran')!.id);
    expect(co.confiance).toBe('incertain');
    expect(co.cause).toMatch(/lecture B.*écarté.*lecture A/);
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R18 — quand les deux versions d\'un élément apparié renvoient à un élément écarté, il disparaît ; un statut dont la version A ne couvre plus rien reste par la version B', () => {
    // A : Alpha seul, B : Beta seul ; l'état est lu des deux côtés (même zone) mais vise un composant différent : divergent, les deux versions visent un écarté
    const a = lecture([ecran(1), composant(2, 'Alpha', 100, 'doc#ecran-1'), etat(1, 'doc#composant-2')]);
    const b = lecture([ecran(1), composant(2, 'Beta', 500, 'doc#ecran-1'), etat(1, 'doc#composant-2')]);
    const rec = reconcilier(a, b, 1);
    expect(rec.items.map((i) => i.statut)).toEqual(['concordant', 'seul', 'divergent', 'seul']);
    for (const i of rec.items.filter((x) => x.statut === 'seul')) i.decision = { verdict: 'ecarte', raison: 'absent' };
    expect(assembler(a, b, rec, true).elements.map((e: Obj) => e.type)).toEqual(['ecran']);
    // le statut concorde (il couvre un écran des deux côtés) ; la lecture A le rattache à l'écran 2, seul et écarté
    const petit = { source: { page: 1, zone: { x: 0, y: 0, l: 800, h: 600 } } };
    const c = lecture([ecran(1), ecran(2, petit), statut(1, ['doc#ecran-2'])]);
    const d = lecture([ecran(1), statut(1, ['doc#ecran-1'])]);
    const r2 = reconcilier(c, d, 1);
    r2.items.find((i) => i.statut === 'seul')!.decision = { verdict: 'ecarte', raison: 'un seul écran dessiné' };
    const inv = assembler(c, d, r2, true);
    expect(inv.elements.map((e: Obj) => e.type)).toEqual(['ecran', 'statut']);
    expect(inv.elements[1].couvre).toEqual([inv.elements[0].id]);
    expect(inv.elements[1].confiance).toBe('incertain');
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R19 — un statut qui couvre un silence posé par les deux lectures est concordant et sans doute : le silence réuni est un élément gardé, rien n\'a été écarté', () => {
    const a = lecture([texte(1, 'Layers', 100), silence(1, 'Quelle couleur ?'), statut(1, ['doc#silence-1'])]);
    const b = lecture([texte(1, 'Layers', 100), silence(4, 'Quelle couleur ?'), statut(2, ['doc#silence-4'])]);
    const rec = reconcilier(a, b);
    expect(rec.items.map((i) => i.statut)).toEqual(['concordant', 'concordant', 'silence']);
    const inv = assembler(a, b, rec);
    const st = inv.elements.find((e: Obj) => e.type === 'statut')!;
    expect(st.confiance).toBe('lu');
    expect(st.cause).toBeUndefined();
    expect(st.couvre).toEqual([inv.elements.find((e: Obj) => e.type === 'silence')!.id]);
    expect(checkInventaire(inv)).toEqual([]);
  });

  it('R20 — un statut que B seule porte et qui couvre le silence des deux lectures n\'est pas perdu : confirmé par le troisième regard, il couvre le silence réuni', () => {
    const quatre = [texte(1, 'Layers', 100), texte(2, 'Wind', 400), texte(3, 'Waves', 700), texte(4, 'Tides', 1000)];
    const a = lecture([...quatre, silence(1, 'Quelle couleur ?')]);
    const b = lecture([...quatre, silence(4, 'Quelle couleur ?'), statut(2, ['doc#silence-4'])]);
    const rec = reconcilier(a, b);
    const seul = rec.items.find((i) => i.statut === 'seul')!;
    expect(seul.element.type).toBe('statut');
    seul.decision = { verdict: 'confirme', raison: 'badge lisible' };
    const inv = assembler(a, b, rec, true);
    expect(inv.elements.map((e: Obj) => e.id)).toEqual(['doc#texte-1', 'doc#texte-2', 'doc#texte-3', 'doc#texte-4', 'doc#statut-1', 'doc#silence-1']);
    expect(inv.elements.find((e: Obj) => e.type === 'statut').couvre).toEqual(['doc#silence-1']);
    expect(checkInventaire(inv)).toEqual([]);
  });
});

describe('cadence ref diff <a> <b> (L266)', () => {
  function setup(a: Obj, b: Obj) {
    const base = tempDir();
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'a.json'), JSON.stringify(a));
    writeFileSync(join(base, 'b.json'), JSON.stringify(b));
    return base;
  }
  async function diff(base: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['ref', 'diff', join(base, 'a.json'), join(base, 'b.json'), ...argv], { cwd: base, env: { ...process.env, RAF_TODAY: '2026-10-25' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-25T10:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('R13 — code 0 : le compte (concordants, divergents, seuls, silences), une ligne par divergent et par seul ; --out écrit l\'inventaire, valide', async () => {
    const base = setup(
      lecture([texte(1, 'Layers', 100), texte(2, '120 KT', 400), texte(3, 'Wind', 700), texte(4, 'Waves', 1000), silence(1, 'Quel état vide ?')]),
      lecture([texte(1, 'Layers', 100), texte(2, '120 kt', 400), texte(3, 'Wind', 700), texte(4, 'Waves', 1000), texte(5, 'Seul', 1300)]),
    );
    const r = await diff(base, '--out', join(base, 'inventaire.json'), '--seuil', '50');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('concordants : 3 · divergents : 1 · seuls : 1 (A : 0, B : 1) · silences : 1');
    expect(r.out).toMatch(/divergent : texte p\.1 : libelle : A « 120 KT » ≠ B « 120 kt »/);
    expect(r.out).toMatch(/seul \(B\) : texte p\.1 : Seul/);
    const inv = JSON.parse(readFileSync(join(base, 'inventaire.json'), 'utf8'));
    expect(inv.genre).toBe('inventaire');
    expect(checkInventaire(inv)).toEqual([]);
    expect(inv.elements).toHaveLength(6);
  });

  it('R14 — plus de 30 % de non appariés : code 1, la question au lead, rien d\'écrit ; --seuil règle (en pour cent)', async () => {
    const base = setup(lecture([texte(1, 'A', 100)]), lecture([texte(1, 'B', 100, { source: { page: 3, zone: zone(100) } })]));
    const r = await diff(base, '--out', join(base, 'inventaire.json'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('plus de 30 % d\'éléments non appariés');
    expect(r.out).toContain('question au lead');
    expect(existsSync(join(base, 'inventaire.json'))).toBe(false);
    expect((await diff(base, '--seuil', '100')).code).toBe(0);
  });

  it('R15 — deux lectures de documents différents (slug ou empreinte), un inventaire ou un fichier invalide : code 2, rien d\'écrit', async () => {
    const a = lecture([texte(1, 'A', 100)]);
    const autre = setup(a, lecture([texte(1, 'A', 100)], { document: { slug: 'doc', sha256: 'b'.repeat(64) } }));
    const r = await diff(autre, '--out', join(autre, 'inventaire.json'));
    expect(r.code).toBe(2);
    expect(r.err).toContain('empreinte');
    expect(existsSync(join(autre, 'inventaire.json'))).toBe(false);
    const inv = setup(a, { ...a, genre: 'inventaire' });
    expect((await diff(inv)).err).toContain('lecture');
    const faux = setup(a, lecture([{ type: 'texte' }]));
    const f = await diff(faux);
    expect(f.code).toBe(2);
    expect(f.err).toContain('b.json');
    const err: string[] = [];
    expect(await run(['ref', 'diff', join(faux, 'a.json')], { cwd: faux, env: process.env, out: () => undefined, err: (l) => err.push(l), now: () => new Date() })).toBe(2);
    expect(err.join('\n')).toContain('usage : cadence ref diff');
  });

  it('R16 (L367) — --out sur un inventaire valide déjà écrit : un élément relu garde son id, un élément inséré prend un numéro neuf et les exclusions écrites passent dans le nouvel inventaire', async () => {
    const base = setup(
      lecture([texte(1, 'Layers', 100), texte(2, 'Valider', 400), texte(3, 'Annuler', 700)]),
      lecture([texte(1, 'Layers', 100), texte(2, 'Valider', 400), texte(3, 'Annuler', 700)]),
    );
    const out = join(base, 'inventaire.json');
    expect((await diff(base, '--out', out)).code).toBe(0);
    const exclusions = [{ id: 'doc#texte-3', raison: 'décor' }];
    writeFileSync(out, JSON.stringify({ ...JSON.parse(readFileSync(out, 'utf8')), exclusions }));
    // « Intrus » s'insère en tête : la numérotation par ordre ferait glisser « Valider » et « Annuler »
    const intrus = texte(1, 'Intrus', 1300);
    for (const [nom, rest] of [['a.json', [texte(2, 'Layers', 100), texte(3, 'Valider', 400), texte(4, 'Annuler', 700)]], ['b.json', [texte(2, 'Layers', 100), texte(3, 'Valider', 400), texte(4, 'Annuler', 700)]]] as const) {
      writeFileSync(join(base, nom), JSON.stringify(lecture([intrus, ...rest])));
    }
    expect((await diff(base, '--out', out)).code).toBe(0);
    const inv = JSON.parse(readFileSync(out, 'utf8'));
    expect(inv.elements.map((e: Obj) => [e.id, e.libelle])).toEqual([['doc#texte-4', 'Intrus'], ['doc#texte-1', 'Layers'], ['doc#texte-2', 'Valider'], ['doc#texte-3', 'Annuler']]);
    expect(inv.exclusions).toEqual(exclusions);
  });
});

describe('ids stables d\'un inventaire relu (L367)', () => {
  const lire = (elements: Obj[]) => lecture(elements);
  const precedent = (elements: Obj[], o: Obj = {}): Obj => ({ version: 1, genre: 'inventaire', document: { slug: 'doc', sha256: SHA }, elements, ...o });
  it('R1 — un élément relu garde l\'id de l\'inventaire précédent, un élément inséré avant prend un numéro neuf et aucun numéro n\'est réutilisé', () => {
    const avant = precedent([texte(1, 'Layers', 100), texte(2, 'Valider', 400), texte(3, 'Annuler', 700)]);
    // « Intrus » s'insère avant « Valider » et « Layers » a disparu : la numérotation par ordre glisserait
    const a = lire([texte(1, 'Intrus', 50, { source: { page: 1, zone: zone(50) } }), texte(2, 'Valider', 400), texte(3, 'Annuler', 700)]);
    const b = lire([texte(4, 'Intrus', 51), texte(5, 'Valider', 401), texte(6, 'Annuler', 701)]);
    const inv = assembler(a, b, reconcilier(a, b), false, avant);
    expect(inv.elements.map((e: Obj) => [e.id, e.libelle])).toEqual([['doc#texte-4', 'Intrus'], ['doc#texte-2', 'Valider'], ['doc#texte-3', 'Annuler']]);
    expect(checkInventaire(inv)).toEqual([]);
  });
  it('R1 — sans inventaire précédent, ou d\'un autre document, la numérotation est celle de l\'ordre', () => {
    const a = lire([texte(1, 'Layers', 100), texte(2, 'Wind', 400)]);
    const b = lire([texte(7, 'Wind', 402), texte(9, 'Layers', 101)]);
    expect(ids(assembler(a, b, reconcilier(a, b), false, precedent([texte(5, 'Wind', 400)], { document: { slug: 'autre', sha256: SHA } })))).toEqual(['doc#texte-1', 'doc#texte-2']);
  });
  it('R3 — les exclusions écrites de l\'inventaire précédent passent dans le nouveau', () => {
    const a = lire([texte(1, 'Layers', 100)]);
    const b = lire([texte(4, 'Layers', 101)]);
    const exclusions = [{ id: 'doc#texte-1', raison: 'décor' }];
    expect(assembler(a, b, reconcilier(a, b), false, precedent([texte(1, 'Layers', 100)], { exclusions })).exclusions).toEqual(exclusions);
    expect(assembler(a, b, reconcilier(a, b)).exclusions).toBeUndefined();
  });
});
