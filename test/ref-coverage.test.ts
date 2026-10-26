import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { idsInText, lotIds } from '../src/ref/coverage.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, specReport, type Handler } from './orchestrate-harness.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { ecrit } from './spec-helpers.js';
import { tempDir } from './helpers.js';

// L367 (issue #19) : la couverture d'un document de référence.
type Obj = Record<string, any>;
const SHA = 'a'.repeat(64);
const zone = { x: 10, y: 20, l: 100, h: 40 };
const base = { source: { page: 1, zone }, confiance: 'lu' };
const ELEMENTS: Obj[] = [
  { ...base, type: 'texte', id: 'doc#texte-1', libelle: 'Valider', role: 'bouton' },
  { ...base, type: 'texte', id: 'doc#texte-2', libelle: 'Annuler', role: 'bouton' },
  { ...base, type: 'silence', id: 'doc#silence-1', source: { page: 2 }, confiance: 'incertain', cause: 'rien', question: 'Que se passe-t-il hors ligne ?' },
];
const inventaire = (extra: Obj = {}): Obj => ({ version: 1, genre: 'inventaire', document: { slug: 'doc', sha256: SHA }, elements: ELEMENTS, ...extra });

type LotSpec = { title: string; status?: 'todo' | 'doing' | 'done' | 'dropped'; note?: string };
/** Un dépôt jetable : un plan aux lots donnés (L1, L2…) et l'inventaire écrit ; `coverage` lance la commande depuis ce dossier. */
function projet(lots: LotSpec[], inv: unknown = inventaire()) {
  const dir = tempDir();
  mkdirSync(join(dir, '.cadence'));
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2026-10-01');
  for (const l of lots) {
    const id = plan.add(l.title, '2026-10-01', { estimate: 1 });
    if (l.note) plan.note(id, l.note, '2026-10-02');
    if (l.status === 'doing' || l.status === 'done') plan.setStatus(id, 'doing', '2026-10-02');
    if (l.status === 'done') plan.setStatus(id, 'done', '2026-10-03', { force: true });
    if (l.status === 'dropped') plan.setStatus(id, 'dropped', '2026-10-03');
  }
  plan.save();
  const file = join(dir, 'inventaire.json');
  writeFileSync(file, typeof inv === 'string' ? inv : JSON.stringify(inv));
  return {
    dir,
    file,
    coverage: (args: string[] = [file]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = run(['ref', 'coverage', ...args], { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-26T10:00:00') }) as number;
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
  };
}

describe('R1 — l\'id d\'un élément est son adresse stable, citée par les lots', () => {
  it('R1 — idsInText retrouve les ids <slug>#<type>-<n> d\'un texte et ignore #19, L12 et les types inconnus', () => {
    expect(idsInText('Écran doc#ecran-1 (issue #19, lot L12), doc#texte-3 et doc#texte-3 ; mon-doc#silence-12 ; doc#autre-4')).toEqual(['doc#ecran-1', 'doc#texte-3', 'mon-doc#silence-12']);
  });
  it('R1 — lotIds lit le titre, l\'objectif et les notes', () => {
    expect(lotIds({ title: 'a doc#texte-1', goal: 'b doc#texte-2', notes: [{ date: '2026-10-01', text: 'c doc#silence-1' }] })).toEqual(['doc#texte-1', 'doc#texte-2', 'doc#silence-1']);
  });
  it('R1 — le modèle templates/inventaire.json donne à chaque élément un id distinct que idsInText retrouve', () => {
    const model = JSON.parse(readFileSync(join(import.meta.dirname, '../templates/inventaire.json'), 'utf8'));
    const ids = model.elements.map((e: Obj) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(idsInText(ids.join(' '))).toEqual(ids);
  });
});

describe('R2 — l\'agent planificateur propose seulement', () => {
  const agent = readAgents(AGENTS_DIR)['reference-planner']!;
  it('R2 — l\'agent existe et n\'a aucun outil d\'écriture', () => {
    expect(agent).toBeDefined();
    expect(agent.tools).toBeDefined();
    for (const t of ['Write', 'Edit', 'NotebookEdit']) expect(agent.tools).not.toContain(t);
  });
  it('R2 — il propose des lots avec ids, faisable ou bloqué (donnée ou service manquant nommé) et dépendances, sans rien créer', () => {
    const text = readFileSync(join(AGENTS_DIR, 'reference-planner.md'), 'utf8');
    for (const key of ['`ids`', '`faisable`', '`bloque_par`', '`depend_de`', 'cadence ref coverage']) expect(text).toContain(key);
    expect(text).toMatch(/missing datum or service/);
    expect(text).toMatch(/no `raf add\|start\|done\|note\|review\|ux`/);
  });
});

describe('R3 — cadence ref coverage <inventaire.json>', () => {
  it('R3 — aucun lot : chaque élément est un écart, code 1, une ligne ✗ avec sa page et sa zone', () => {
    const r = projet([]).coverage();
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ doc#texte-1 (texte p.1 zone 10,20,100,40 « Valider ») : aucun lot, aucune exclusion écrite');
    expect(r.out).toContain('✗ doc#silence-1 (silence p.2 « Que se passe-t-il hors ligne ? ») : aucun lot');
    expect(r.out).toContain('3 élément(s) sans lot fait ni exclusion écrite sur 3');
    expect(r.err).toBe('');
  });
  it('R3 — un lot fait qui cite l\'id le couvre ; un lot en cours ne suffit pas et est nommé', () => {
    const r = projet([{ title: 'Les boutons doc#texte-1', status: 'done' }, { title: 'Annuler doc#texte-2', status: 'doing' }]).coverage();
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('✗ doc#texte-1');
    expect(r.out).toContain('✗ doc#texte-2 (texte p.1 zone 10,20,100,40 « Annuler ») : lot non fait (L2 doing)');
    expect(r.out).toContain('2 élément(s) sans lot fait');
  });
  it('R3 — un lot abandonné ne couvre rien, une note du lot suffit à citer', () => {
    const r = projet([{ title: 'Abandonné doc#texte-1', status: 'dropped' }, { title: 'Le reste', note: 'couvre doc#texte-2 et doc#silence-1', status: 'done' }]).coverage();
    expect(r.out).toContain('✗ doc#texte-1 (texte p.1 zone 10,20,100,40 « Valider ») : aucun lot');
    expect(r.out).not.toContain('✗ doc#texte-2');
    expect(r.out).not.toContain('✗ doc#silence-1');
    expect(r.code).toBe(1);
  });
  it('R3 — tout élément a un lot fait ou une exclusion écrite avec sa raison : code 0 et le décompte', () => {
    const p = projet([{ title: 'Boutons doc#texte-1 doc#silence-1', status: 'done' }], inventaire({ exclusions: [{ id: 'doc#texte-2', raison: 'décor du document, pas du produit' }] }));
    const r = p.coverage();
    expect(r.out).toBe('couverture complète : 3 éléments (2 par un lot fait, 1 exclus avec leur raison)');
    expect(r.code).toBe(0);
  });
  it('R3 — une exclusion sans raison, ou d\'un id inconnu, n\'exclut rien : écart, code 1', () => {
    const p = projet([{ title: 'tout doc#texte-1 doc#silence-1', status: 'done' }], inventaire({ exclusions: [{ id: 'doc#texte-2', raison: '  ' }, { id: 'doc#texte-9', raison: 'x' }] }));
    const r = p.coverage();
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ exclusions[0].raison : la raison de l\'exclusion de doc#texte-2 est obligatoire');
    expect(r.out).toContain('✗ exclusions[1].id : doc#texte-9 ne désigne aucun élément de l\'inventaire');
    expect(r.out).toContain('✗ doc#texte-2 (texte');
    expect(r.out).toContain('1 élément(s) sans lot fait ni exclusion écrite, 2 exclusion(s) refusée(s) sur 3');
  });
  it('R3 — des exclusions qui ne sont pas un tableau sont un écart, pas un plantage', () => {
    const r = projet([{ title: 'doc#texte-1 doc#texte-2 doc#silence-1', status: 'done' }], inventaire({ exclusions: 'rien' })).coverage();
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ exclusions : un tableau [{ id, raison }] est attendu');
  });
  it('R3 — un élément à la fois couvert par un lot fait et exclu est compté couvert une seule fois', () => {
    const r = projet([{ title: 'doc#texte-1 doc#texte-2 doc#silence-1', status: 'done' }], inventaire({ exclusions: [{ id: 'doc#texte-1', raison: 'redondant' }] })).coverage();
    expect(r.out).toBe('couverture complète : 3 éléments (3 par un lot fait, 0 exclus avec leur raison)');
    expect(r.code).toBe(0);
  });
  it('R3 — mauvais appel ou fichier inutilisable : code 2, raison sur stderr, rien d\'écrit', () => {
    const p = projet([]);
    expect(p.coverage([])).toMatchObject({ code: 2, out: '' });
    expect(p.coverage([]).err).toContain('usage : cadence ref coverage <inventaire.json>');
    expect(p.coverage([p.file, p.file]).code).toBe(2);
    expect(p.coverage([join(p.dir, 'absent.json')]).err).toContain('fichier introuvable');
    const invalide = projet([], { version: 1, genre: 'inventaire' });
    const r = invalide.coverage();
    expect(r.code).toBe(2);
    expect(r.err).toContain('n\'est ni un inventaire ni une lecture valide');
  });
  it('R3 — une lecture (ce que ref analyse écrit sans --double) se couvre comme un inventaire, ses exclusions comprises', () => {
    const p = projet([{ title: 'Valider doc#texte-1', status: 'done' }], inventaire({ genre: 'lecture', exclusions: [{ id: 'doc#texte-2', raison: 'décor' }, { id: 'doc#silence-1', raison: 'hors produit' }] }));
    const r = p.coverage();
    expect(r.err).toBe('');
    expect(r.out).toBe('couverture complète : 3 éléments (1 par un lot fait, 2 exclus avec leur raison)');
    expect(r.code).toBe(0);
  });
  it('R3 — sans plan, le refus dit que le plan manque (code 2)', () => {
    const dir = tempDir();
    const file = join(dir, 'inventaire.json');
    writeFileSync(file, JSON.stringify(inventaire()));
    const err: string[] = [];
    const code = run(['ref', 'coverage', file], { cwd: dir, env: {}, out: () => undefined, err: (l) => err.push(l), now: () => new Date('2026-10-26T10:00:00') }) as number;
    expect(code).toBe(2);
    expect(err.join('\n')).not.toBe('');
  });
  it('R3 — le sous-verbe est dans l\'usage de cadence ref', () => {
    const err: string[] = [];
    run(['ref'], { cwd: tempDir(), env: {}, out: () => undefined, err: (l) => err.push(l), now: () => new Date('2026-10-26T10:00:00') });
    expect(err.join('\n')).toContain('cadence ref coverage <inventaire.json>');
  });
});

describe('R4 — les briefs portent les ids du lot', () => {
  const lotsAvecIds = [{ title: 'Écran doc#ecran-1 et doc#texte-2, sans doc#texte-3', screen: 'page' as const }];
  const ux = { url: 'http://localhost:4200' };
  const ok: Handler = () => claudeOut(reviewReport());
  const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
  const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd, {}) }));

  it('R4 — le brief du spec-writer liste les ids du lot et demande de justifier chaque élément non pris', async () => {
    const h = harness({ lots: lotsAvecIds, script: { spec: [spec], implement: [impl], ux: [ok], review: [ok] } });
    await runLot(h.lot('L1', { visible: true, screen: 'page' }, { ux }));
    const b = h.calls.find((c) => c.kind === 'spec')!.brief;
    for (const id of ['doc#ecran-1', 'doc#texte-2', 'doc#texte-3']) expect(b).toContain(`\`${id}\``);
    expect(b).toContain('justified');
    expect(b).toContain('hors_perimetre');
  });
  it('R4 — le brief du ux-reviewer liste les mêmes ids et demande de les vérifier sur l\'écran fini', async () => {
    const h = harness({ lots: lotsAvecIds, script: { spec: [spec], implement: [impl], ux: [ok], review: [ok] } });
    await runLot(h.lot('L1', { visible: true, screen: 'page' }, { ux }));
    const b = h.calls.find((c) => c.kind === 'ux')!.brief;
    for (const id of ['doc#ecran-1', 'doc#texte-2', 'doc#texte-3']) expect(b).toContain(`\`${id}\``);
    expect(b).toContain('On the finished screen, verify each one');
  });
  it('R4 — un petit lot visible (une seule passe review-small, pas de ux) y reçoit les ids et la consigne de vérification sur l\'écran fini', async () => {
    const h = harness({ lots: [{ title: 'Écran doc#texte-3', estimate: 0.5, visible: true }], script: { implement: [impl], 'review-small': [ok] } });
    await runLot(h.lot('L1', { visible: true, small: true }, { ux }));
    expect(h.calls.some((c) => c.kind === 'ux')).toBe(false);
    const b = h.calls.find((c) => c.kind === 'review-small')!.brief;
    expect(b).toContain('`doc#texte-3`');
    expect(b).toContain('On the finished screen, verify each one');
  });
  it('R4 — un petit lot visible qui ne cite aucun id garde son brief review-small inchangé', async () => {
    const h = harness({ lots: [{ title: 'Un écran', estimate: 0.5, visible: true }], script: { implement: [impl], 'review-small': [ok] } });
    await runLot(h.lot('L1', { visible: true, small: true }, { ux }));
    expect(h.calls.find((c) => c.kind === 'review-small')!.brief).not.toContain('reference document');
  });
  it('R4 — un lot qui ne cite aucun id garde ses briefs inchangés', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' as const }], script: { spec: [spec], implement: [impl], ux: [ok], review: [ok] } });
    await runLot(h.lot('L1', { visible: true, screen: 'page' }, { ux }));
    for (const kind of ['spec', 'ux']) expect(h.calls.find((c) => c.kind === kind)!.brief).not.toContain('reference document');
  });

});

describe('R3 — ce qui compte comme citation et comme couverture (L367, revue)', () => {
  it('R3 — une note que le programme écrit (titre remplacé, mineur de revue, hypothèses, sous-tâche) ne cite aucun élément', () => {
    const p = projet([{ title: 'Écran doc#texte-1', status: 'done' }]);
    const plan = Plan.load(join(p.dir, '.cadence/raf.yaml'));
    plan.note('L1', 'titre remplacé : « Écran doc#texte-2 »', '2026-10-04');
    plan.note('L1', 'Revue de la fiche — mineur : docs/x.yaml — doc#texte-2 manque', '2026-10-04');
    plan.note('L1', 'Hypothèses (fiche ecran) : doc#silence-1', '2026-10-04');
    plan.note('L1', 'remis en attente : doc#texte-2', '2026-10-04');
    plan.save();
    const sousTache = Plan.load(join(p.dir, '.cadence/raf.yaml'));
    const tache = sousTache.addTask('L1', 'T');
    sousTache.note(tache, 'voir doc#texte-2', '2026-10-04');
    sousTache.save();
    expect(lotIds(Plan.load(join(p.dir, '.cadence/raf.yaml')).lots()[0]!)).toEqual(['doc#texte-1']);
    const r = p.coverage();
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ doc#texte-2');
    expect(r.out).toContain('✗ doc#silence-1');
    expect(r.out).not.toContain('✗ doc#texte-1');
  });
  it('R3 — un titre remplacé par raf title ne laisse pas l\'ancien titre citer', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.cadence'));
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2026-10-01');
    plan.add('Écran doc#texte-1 doc#texte-2', '2026-10-01', { estimate: 1 });
    plan.setTitle('L1', 'Écran doc#texte-1', '2026-10-02');
    expect(lotIds(plan.lots()[0]!)).toEqual(['doc#texte-1']);
  });
  describe('un élément que la fiche du lot justifie comme non pris', () => {
    const fiche = (hors: string[]) => `sujet:\n  id: doc\n  titre: Doc\n  lot: L1\n  perimetre:\n    modules: [a]\n    endpoints: []\n    jobs: []\n    hors_perimetre:\n${hors.map((h) => `      - "${h}"`).join('\n')}\n`;
    it('R3 — n\'est pas couvert par le lot fait : écart nommant la raison, code 1', () => {
      const p = projet([{ title: 'Écran doc#texte-1 doc#texte-2 doc#silence-1', status: 'done' }]);
      mkdirSync(join(p.dir, 'docs/specs/doc'), { recursive: true });
      writeFileSync(join(p.dir, 'docs/specs/doc/fiche.yaml'), fiche(['doc#texte-2 : service absent', 'rien à voir']));
      const r = p.coverage();
      expect(r.code).toBe(1);
      expect(r.out).toContain('✗ doc#texte-2 (texte p.1 zone 10,20,100,40 « Annuler ») : justifié non pris par la fiche de L1 : service absent, sans exclusion écrite');
      expect(r.out).not.toContain('✗ doc#texte-1');
      expect(r.out).toContain('1 élément(s) sans lot fait ni exclusion écrite sur 3');
    });
    it('R3 — une exclusion écrite par le lead le couvre', () => {
      const p = projet([{ title: 'Écran doc#texte-1 doc#texte-2 doc#silence-1', status: 'done' }], inventaire({ exclusions: [{ id: 'doc#texte-2', raison: 'service absent, décidé' }] }));
      mkdirSync(join(p.dir, 'docs/specs/doc'), { recursive: true });
      writeFileSync(join(p.dir, 'docs/specs/doc/fiche.yaml'), fiche(['doc#texte-2 : service absent']));
      const r = p.coverage();
      expect(r.out).toBe('couverture complète : 3 éléments (2 par un lot fait, 1 exclus avec leur raison)');
      expect(r.code).toBe(0);
    });
    it('R3 — la fiche d\'un autre lot, ou une ligne sans raison, ne justifie rien', () => {
      const autre = projet([{ title: 'Écran doc#texte-1 doc#texte-2 doc#silence-1', status: 'done' }]);
      mkdirSync(join(autre.dir, 'docs/specs/doc'), { recursive: true });
      writeFileSync(join(autre.dir, 'docs/specs/doc/fiche.yaml'), fiche(['doc#texte-2 : service absent']).replace('lot: L1', 'lot: L9'));
      expect(autre.coverage().code).toBe(0);
      const sansRaison = projet([{ title: 'Écran doc#texte-1 doc#texte-2 doc#silence-1', status: 'done' }]);
      mkdirSync(join(sansRaison.dir, 'docs/specs/doc'), { recursive: true });
      writeFileSync(join(sansRaison.dir, 'docs/specs/doc/fiche.yaml'), fiche(['doc#texte-2 :']));
      expect(sansRaison.coverage().code).toBe(0);
    });
  });
});
