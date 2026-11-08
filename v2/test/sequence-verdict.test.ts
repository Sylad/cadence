import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Meca } from '../src/bench/juges.js';
import { statut } from '../src/bench/verdict.js';
import type { Base, MesureEtape, ResultatSequence } from '../src/sequence/passage.js';
import { conclureSequence, ligneSequence, rapportSequence, verdictSequence } from '../src/sequence/verdict.js';

const maint = (dup: number | null, f400: number) => ({ duplication_pct: dup, plus_gros: [], fichiers_400: f400 });
const etape = (k: number, o: Partial<MesureEtape> = {}): MesureEtape => ({
  k, portee_suite: 'tout', fuites: [], fuites_a_verifier: [], suite_en_erreur: null, mesure_en_erreur: null,
  mesure: { bras: 'x', banc: 's', debut: '', fin: '', duree_s: 100, tokens: 1, cout_usd: 1, questions: 0, questions_texte: [], sessions: [], echec: null },
  lecture: { ouvertes: ['p1'], manquantes: [], apres_ecriture: [], partielles: [] }, suite: { passes: 10, total: 10 },
  regressions: { rouges: [], disparus: [] }, nouveaux: ['n'], tests_affaiblis: { fichiers_supprimes: [], tests_retires: [], skip_only: [] },
  build_ok: true, maintenabilite: maint(2, 1), ...o });
const meca = (o: Partial<Meca> = {}): Meca => ({ suite_ok: true, caches_passes: 10, caches_total: 12, mutations_tuees: 5, mutations_total: 6, attendu: 'oui', mutations: [], ...o });
const base = (): Base => ({ suite: { passes: 10, total: 10 }, build_ok: true, maintenabilite: maint(2, 1) });
function seq(f: (r: ResultatSequence) => void = () => {}): ResultatSequence {
  const r: ResultatSequence = { run: 'r1', sequence: 'aether-b68', clones: { c1: 'A', c2: 'C' }, base: { A: base(), C: base() }, reglages_utilisateur: [],
    etapes: { A: [etape(1), etape(2)], C: [etape(1), etape(2)] },
    jugement: { meca: { A: meca(), C: meca() }, remplaces: ['t1'], defauts: {}, prefere: 'egal', ui: 'na', raisons: '' } };
  f(r);
  return r;
}
const v = (r: ResultatSequence) => verdictSequence(r, 'A', 'C');
const crit = (r: ResultatSequence, nom: string) => v(r).criteres.find((c) => c.nom === nom)!;
const rouges = (r: ResultatSequence) => v(r).criteres.filter((c) => c.bloquant && !c.ok).map((c) => c.nom);

describe('verdictSequence : un critère par ligne, vert puis rouge', () => {
  it('une séquence égale aux deux bras est verte', () => expect(rouges(seq())).toEqual([]));
  it('séquence vide : rouge', () => {
    expect(rouges(seq((r) => { r.etapes = { A: [], C: [] }; }))).toContain('au moins une étape');
    expect(rouges(seq((r) => { r.etapes = {}; }))).toContain('au moins une étape');
    expect(rouges(seq((r) => { r.etapes.C = [etape(1)]; }))).toContain('au moins une étape'); // pas le même nombre d'étapes
    expect(rouges(seq((r) => { r.etapes.C = [etape(1), etape(3)]; }))).toContain('au moins une étape'); // pas les mêmes numéros
  });
  it('régressions ≤ référence, cumulées sur la séquence (rouges + disparus)', () => {
    expect(crit(seq((r) => { r.etapes.A[0].regressions = { rouges: ['a'], disparus: [] }; r.etapes.C[1].regressions = { rouges: [], disparus: ['b'] }; }), 'régressions'))
      .toMatchObject({ valeur: '1 contre 1', ok: true });
    expect(crit(seq((r) => { r.etapes.C[0].regressions = { rouges: ['a'], disparus: [] }; r.etapes.C[1].regressions = { rouges: [], disparus: ['b'] }; }), 'régressions'))
      .toMatchObject({ valeur: '2 contre 0', ok: false });
  });
  it('suite en erreur à la DERNIÈRE étape (regressions absent) : rouge, pour le candidat comme pour la référence', () => {
    for (const b of ['A', 'C']) {
      const r = seq((x) => { x.etapes[b][1] = etape(2, { regressions: undefined, suite: undefined, suite_en_erreur: 'vitest planté' }); });
      expect(crit(r, 'régressions')).toMatchObject({ ok: false });
      expect(crit(r, 'régressions').valeur).toContain('non mesuré');
      expect(rouges(r)).toContain('toutes les étapes mesurées');
    }
  });
  it('R36 : réglages utilisateur changés pendant le passage (à une étape ou avant les juges) : rouge, fichiers nommés ; non mesuré : rouge', () => {
    const nom = 'réglages utilisateur inchangés pendant le passage';
    expect(crit(seq(), nom)).toMatchObject({ valeur: 'inchangés', ok: true, bloquant: true });
    expect(crit(seq((r) => { r.etapes.A[0].reglages_utilisateur = ['/h/.claude/RTK.md']; }), nom)).toMatchObject({ valeur: '/h/.claude/RTK.md', ok: false });
    expect(crit(seq((r) => { r.reglages_utilisateur = ['/h/.claude/CLAUDE.md']; r.etapes.C[1].reglages_utilisateur = ['/h/.claude/CLAUDE.md']; }), nom))
      .toMatchObject({ valeur: '/h/.claude/CLAUDE.md', ok: false });
    expect(crit(seq((r) => { r.reglages_utilisateur = undefined; }), nom)).toMatchObject({ valeur: 'non mesuré', ok: false });
  });
  it('mesure en erreur : étape non mesurée, rouge', () => {
    expect(rouges(seq((r) => { r.etapes.C[0].mesure_en_erreur = 'build : boom'; }))).toEqual(['toutes les étapes mesurées']);
  });
  it('R35 : tests cachés cumulés affichés, jamais bloquants ; juge absent : rouge sur les autres critères du juge', () => {
    expect(crit(seq((r) => { r.jugement!.meca.C.caches_passes = 11; }), 'tests cachés cumulés')).toMatchObject({ valeur: '11 contre 10', ok: true, bloquant: false });
    expect(crit(seq((r) => { r.jugement!.meca.C.caches_passes = 9; }), 'tests cachés cumulés')).toMatchObject({ ok: false, bloquant: false });
    expect(v(seq((r) => { r.jugement!.meca.C.caches_passes = 9; })).vert).toBe(true);
    expect(v(seq((r) => { r.sorties_attendues = 1; for (const b of ['A', 'C']) r.jugement!.meca[b].sorties = [{ k: 1, sortie: 's', verdict: 'oui', preuve: 'p' }]; r.jugement!.meca.C.caches_passes = 0; })).vert).toBe(true);
    const sans = seq((r) => { r.jugement = null; });
    expect(rouges(sans)).toEqual(expect.arrayContaining(['juge final fait', 'suite du candidat au juge final', 'attendu au juge final']));
    expect(rouges(sans)).not.toContain('tests cachés cumulés');
  });
  it('R35 : sorties attendues vérifiées (oui du candidat ≥ oui de la référence), seulement si la séquence en déclare', () => {
    const nom = 'sorties attendues vérifiées';
    const so = (...vs: string[]) => vs.map((verdict, i) => ({ k: i + 1, sortie: `s${i + 1}`, verdict: verdict as 'oui', preuve: 'p' }));
    const avec = (a: string[], c: string[]) => seq((r) => { r.sorties_attendues = a.length; r.jugement!.meca.A.sorties = so(...a); r.jugement!.meca.C.sorties = so(...c); });
    expect(crit(seq(), nom)).toBeUndefined(); // séquence sans sorties : inchangé
    expect(crit(avec(['oui', 'non'], ['oui', 'oui']), nom)).toMatchObject({ valeur: '2/2 contre 1/2', ok: true, bloquant: true });
    expect(crit(avec(['oui', 'oui'], ['oui', 'incertain']), nom)).toMatchObject({ valeur: '1/2 contre 2/2', ok: false });
    expect(rouges(avec(['non', 'non'], ['non', 'non']))).toEqual([]);
    expect(crit(seq((r) => { r.sorties_attendues = 2; }), nom)).toMatchObject({ ok: false }); // juge sans sorties : échec fermé
    expect(crit(seq((r) => { r.sorties_attendues = 2; r.jugement = null; }), nom)).toMatchObject({ valeur: '– contre –', ok: false });
  });
  it('juge final : suite du candidat verte ; attendu (oui 2, en partie 1, non 0) ≥ référence', () => {
    expect(rouges(seq((r) => { r.jugement!.meca.C.suite_ok = false; }))).toEqual(['suite du candidat au juge final']);
    expect(rouges(seq((r) => { r.jugement!.meca.A.suite_ok = false; }))).toEqual([]);
    expect(crit(seq((r) => { r.jugement!.meca.C.attendu = 'en partie'; }), 'attendu au juge final')).toMatchObject({ valeur: '1 contre 2 (oui 2, en partie 1, non 0)', ok: false });
    expect(crit(seq((r) => { r.jugement!.meca.A.attendu = 'non'; r.jugement!.meca.C.attendu = 'en partie'; }), 'attendu au juge final')).toMatchObject({ ok: true });
  });
  it('questions inutiles du candidat = 0 ; une étape avec reponses.md les permet', () => {
    expect(crit(seq((r) => { r.etapes.C[1].mesure.questions = 1; }), 'questions inutiles')).toMatchObject({ valeur: '1', ok: false });
    expect(crit(seq((r) => { r.etapes.C[1].mesure.questions = 1; r.etapes.C[1].reponses = true; }), 'questions inutiles')).toMatchObject({ ok: true });
    expect(crit(seq((r) => { r.etapes.A[1].mesure.questions = 3; }), 'questions inutiles')).toMatchObject({ ok: true });
  });
  it('lecture : 100 % des pièces du candidat avant le code ; la référence est montrée, pas bloquante', () => {
    const lu = { ouvertes: [], manquantes: ['p1'], apres_ecriture: [], partielles: [] };
    expect(crit(seq((r) => { r.etapes.A[0].lecture = lu; }), 'pièces lues avant le code')).toMatchObject({ valeur: '2/2 (A : 1/2)', ok: true });
    expect(crit(seq((r) => { r.etapes.C[1].lecture = { ...lu, manquantes: [], apres_ecriture: ['p1'] }; }), 'pièces lues avant le code')).toMatchObject({ valeur: '1/2 (A : 2/2)', ok: false });
    expect(crit(seq((r) => { r.etapes.C[1].lecture = undefined; }), 'pièces lues avant le code')).toMatchObject({ ok: false });
    // lue en partie (offset, limit, pages) : ne compte pas (R30)
    expect(crit(seq((r) => { r.etapes.C[1].lecture = { ouvertes: ['p1'], manquantes: [], apres_ecriture: [], partielles: ['p1'] }; }), 'pièces lues avant le code'))
      .toMatchObject({ valeur: '1/2 (1 partiel) (A : 2/2)', ok: false });
    const sansPiece = { ouvertes: [], manquantes: [], apres_ecriture: [], partielles: [] };
    expect(crit(seq((r) => { for (const b of ['A', 'C']) for (const e of r.etapes[b]) e.lecture = sansPiece; }), 'pièces lues avant le code')).toMatchObject({ ok: true });
  });
  it('pente de duplication : dernière étape − étape 0, ≤ référence ; null = « non mesuré », jamais vert', () => {
    expect(crit(seq((r) => { r.etapes.C[1].maintenabilite = maint(2.5, 1); r.etapes.A[1].maintenabilite = maint(3, 1); }), 'pente de duplication')).toMatchObject({ ok: true });
    expect(crit(seq((r) => { r.etapes.C[1].maintenabilite = maint(3, 1); }), 'pente de duplication')).toMatchObject({ valeur: '+1 point contre +0 point', ok: false });
    expect(crit(seq((r) => { r.etapes.C[0].maintenabilite = maint(9, 1); }), 'pente de duplication')).toMatchObject({ ok: true }); // seule la dernière compte
    for (const f of [(r: ResultatSequence) => { r.base.A.maintenabilite = maint(null, 1); }, (r: ResultatSequence) => { r.etapes.C[1].maintenabilite = maint(null, 1); }])
      expect(crit(seq(f), 'pente de duplication')).toMatchObject({ valeur: 'non mesuré', ok: false, bloquant: true });
  });
  it('pente des fichiers de plus de 400 lignes ≤ référence', () => {
    expect(crit(seq((r) => { r.etapes.C[1].maintenabilite = maint(2, 3); }), 'pente des fichiers > 400 lignes')).toMatchObject({ valeur: '+2 contre +0', ok: false });
    expect(crit(seq((r) => { r.base.C.maintenabilite = maint(2, 3); r.etapes.C[1].maintenabilite = maint(2, 3); }), 'pente des fichiers > 400 lignes')).toMatchObject({ ok: true });
  });
  it('temps total ≤ 1,5 × référence', () => {
    expect(crit(seq((r) => { r.etapes.C[0].mesure.duree_s = 200; }), 'temps total')).toMatchObject({ valeur: '300 s contre 200 s', ok: true });
    expect(crit(seq((r) => { r.etapes.C[0].mesure.duree_s = 201; }), 'temps total')).toMatchObject({ ok: false });
  });
  it('build du candidat ok à la dernière étape', () => {
    expect(rouges(seq((r) => { r.etapes.C[0].build_ok = false; }))).toEqual([]);
    expect(rouges(seq((r) => { r.etapes.C[1].build_ok = false; }))).toEqual(['build à la dernière étape']);
  });
  it('aucune fuite certaine, aucun bras en échec', () => {
    expect(rouges(seq((r) => { r.etapes.A[0].fuites = ['/secrets/x']; }))).toEqual(['aucune fuite']);
    expect(rouges(seq((r) => { r.etapes.C[1].fuites_a_verifier = ['/x']; }))).toEqual([]);
    expect(rouges(seq((r) => { r.etapes.A[1].mesure.echec = 'aucun commit'; }))).toEqual(['aucun bras en échec']);
  });
  it('tous les critères sont bloquants, sauf les tests cachés cumulés (R35)', () =>
    expect(v(seq()).criteres.filter((c) => !c.bloquant).map((c) => c.nom)).toEqual(['tests cachés cumulés']));
});

describe('rapport, historique et publication de la séquence', () => {
  it('le rapport : une ligne par étape côte à côte, les critères, lectures, questions, remplacés par bras', () => {
    const r = seq((x) => {
      x.etapes.C[0].regressions = { rouges: ['a'], disparus: ['b', 'c'] };
      x.etapes.C[0].lecture = { ouvertes: ['p1'], manquantes: [], apres_ecriture: [], partielles: ['p1'] };
      x.etapes.C[1].tests_affaiblis = { fichiers_supprimes: ['f.spec.ts'], tests_retires: ['g.spec.ts > t'], skip_only: [] };
      x.etapes.A[1].fuites_a_verifier = ['/x/runs/r'];
      x.etapes.C[1].mesure.questions_texte = ['Quel format ?'];
      x.jugement!.remplaces = ['a.spec.ts > t1', 'b.spec.ts > t2'];
    });
    const md = rapportSequence(r, 'A', 'C', v(r), { date: '2026-11-08', empreinte: 'e1' });
    expect(md).toMatch(/^# Séquence aether-b68 2026-11-08 — C contre A — ROUGE/);
    expect(md).toContain('| Étape | Régressions A · C (rouges/disparus) | Affaiblis A · C | Nouveaux A · C | Lecture A · C | Build A · C | Duplication A · C | Fichiers > 400 A · C | Temps A · C |');
    expect(md).toContain('| 0 | – · – | – · – | – · – | – · – | ok · ok | 2 % · 2 % | 1 · 1 | – · – |');
    expect(md).toContain('| 1 | 0/0 · 1/2 | 0 · 0 | 1 · 1 | 1/1 · 1/1 partiel | ok · ok | 2 % · 2 % | 1 · 1 | 100 s · 100 s |');
    expect(md).toContain('| 2 | 0/0 · 0/0 | 0 · 2 |');
    for (const c of v(r).criteres) expect(md).toContain(`| ${c.nom} |`);
    expect(md).toContain('## Lectures à vérifier\n\n- A étape 2 : /x/runs/r\n- C étape 1 : pièce lue en partie, p1');
    expect(md).toContain('## Questions posées\n\n- C étape 2 : Quel format ?');
    expect(md).toContain('## Tests remplacés (R28), non comptés pour A ni pour C\n\n- a.spec.ts > t1\n- b.spec.ts > t2');
    expect(md).toContain('## Tests affaiblis\n\n- C étape 2 : fichier supprimé f.spec.ts ; test retiré g.spec.ts > t');
    const nul = seq((x) => { x.etapes.C[1] = etape(2, { regressions: undefined, suite_en_erreur: 'boom', maintenabilite: maint(null, 1) }); });
    expect(rapportSequence(nul, 'A', 'C', v(nul), { date: 'd', empreinte: 'e' })).toContain('| 2 | 0/0 · ERREUR |');
    expect(md).not.toContain('## Sorties attendues');
    const so = seq((x) => { x.sorties_attendues = 2; x.jugement!.meca.A.sorties = [{ k: 1, sortie: 'légende D/A', verdict: 'oui', preuve: 'p' }, { k: 2, sortie: 'cartouche', verdict: 'incertain', preuve: 'app non lancée' }];
      x.jugement!.meca.C.sorties = [{ k: 1, sortie: 'légende D/A', verdict: 'non', preuve: 'captures-X/l.png : L/H' }, { k: 2, sortie: 'cartouche', verdict: 'oui', preuve: 'p' }]; });
    expect(rapportSequence(so, 'A', 'C', v(so), { date: 'd', empreinte: 'e' })).toContain('## Sorties attendues non vérifiées (non, incertain)\n\n- A étape 2 : incertain — cartouche (app non lancée)\n- C étape 1 : non — légende D/A (captures-X/l.png : L/H)');
  });
  it('ligne d\'historique type sequence, avec candidat, référence, modèle et empreinte', () => {
    const h = JSON.parse(ligneSequence(v(seq()), { date: 'd', empreinte: 'e1', candidat: 'C', reference: 'A', modele_candidat: 'opus', sequence: 'aether-b68', run: 'r1', repetition: 2 }));
    expect(h).toMatchObject({ type: 'sequence', sequence: 'aether-b68', run: 'r1', repetition: 2, candidat: 'C', reference: 'A', modele_candidat: 'opus', empreinte: 'e1', bancs: ['aether-b68'], hebdo: false, vert: true, rouges: [] });
  });
  it('conclureSequence écrit le rapport, le JSON et la ligne d\'historique', () => {
    const racine = mkdtempSync(join(tmpdir(), 'seq-v-'));
    const vv = conclureSequence(racine, seq(), 'A', 'C', { maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', modele_candidat: 'opus', repetition: 2 });
    expect(vv.vert).toBe(true);
    expect(readFileSync(join(racine, 'rapports', 'r1-aether-b68-r2.md'), 'utf8')).toMatch(/— VERT/);
    expect(JSON.parse(readFileSync(join(racine, 'rapports', 'r1-aether-b68-r2.json'), 'utf8')).verdict.vert).toBe(true);
    expect(JSON.parse(readFileSync(join(racine, 'historique.jsonl'), 'utf8').trim())).toMatchObject({ type: 'sequence', sequence: 'aether-b68', run: 'r1', repetition: 2, vert: true });
  });

  const now = new Date('2026-11-09T08:00:00Z'); const modeles = { C: 'opus', A: 'opus' };
  const court = (o: Record<string, unknown> = {}) => JSON.stringify({ date: '2026-11-07T10:00:00Z', empreinte: 'e1', candidat: 'C', reference: 'A', modele_candidat: 'opus',
    bancs: ['1-a', '3-b', '6-c'], hebdo: true, frais: 0, vert: true, rouges: [], ...o });
  const sequence = (o: Record<string, unknown> = {}) => court({ type: 'sequence', sequence: 'aether-b68', run: 'run1', repetition: 1, repetitions: 1, bancs: ['aether-b68'], hebdo: false, ...o });
  const ok = (h: string[], m: Record<string, string> = modeles) => statut(h, now, 'e1', m).publication_ok;
  it('publication : court ET séquence verts, même candidat, même modèle', () => {
    expect(ok([court(), sequence()])).toBe(true);
    expect(ok([sequence(), court()])).toBe(true);
  });
  it('publication refusée avec seulement un court vert, ou seulement une séquence verte', () => {
    expect(ok([court()])).toBe(false);
    expect(ok([sequence()])).toBe(false);
    expect(ok([court({ vert: false }), sequence()])).toBe(false);
  });
  it('publication refusée : dernière séquence rouge, autre candidat, autre modèle, A contre A, autre empreinte', () => {
    expect(ok([court(), sequence(), sequence({ vert: false })])).toBe(false);
    expect(ok([court(), sequence({ candidat: 'D' })], { ...modeles, D: 'opus' })).toBe(false);
    expect(ok([court(), sequence({ modele_candidat: 'fable' })])).toBe(false);
    expect(ok([court(), sequence({ candidat: 'A' })])).toBe(false);
    expect(ok([court(), sequence({ empreinte: 'e2' })])).toBe(false);
    expect(ok([court(), sequence({ reference: undefined })])).toBe(false);
  });
  it('R30 : chaque id de séquence, toutes les lignes de son dernier run (répétitions) et celles qui suivent, vertes', () => {
    const triviale = sequence({ sequence: 'triviale', bancs: ['triviale'], run: 'run2' });
    expect(ok([court(), sequence({ vert: false }), triviale])).toBe(false); // une triviale verte ne débloque pas la principale rouge
    expect(ok([court(), sequence(), triviale])).toBe(true);
    expect(ok([court(), sequence({ run: 'run2', repetitions: 2 }), sequence({ run: 'run2', repetition: 2, repetitions: 2, vert: false })])).toBe(false);
    expect(ok([court(), sequence({ run: 'run2', repetitions: 2, vert: false }), sequence({ run: 'run2', repetition: 2, repetitions: 2 })])).toBe(false);
    expect(ok([court(), sequence({ vert: false }), sequence({ run: 'run2', repetitions: 2 }), sequence({ run: 'run2', repetition: 2, repetitions: 2 })])).toBe(true); // rouge d'un run plus ancien
    expect(ok([court(), sequence({ run: undefined })])).toBe(false);
  });
  it('répétitions : un run sans ses N lignes (tué), N inconnu ou lignes mêlées refuse la publication', () => {
    const r = (o: Record<string, unknown>) => sequence({ run: 'run2', repetitions: 2, ...o });
    expect(ok([court(), r({}), r({ repetition: 2 })])).toBe(true);
    expect(ok([court(), r({})])).toBe(false); // répétition 2 jamais écrite
    expect(ok([court(), r({ repetition: 2 })])).toBe(false); // répétition 1 absente
    expect(ok([court(), r({}), r({})])).toBe(false); // deux fois la 1
    expect(ok([court(), r({ repetitions: undefined })])).toBe(false); // ancienne ligne sans N
    expect(ok([court(), r({}), r({ repetition: 3 })])).toBe(false);
  });
  it('statut saute les lignes illisibles ou sans date valide ; dernier dit « séquence »', () => {
    const s = statut(['pas du json', '{"vert":true}', JSON.stringify({ date: 'hier', vert: true }), court(), sequence()], now, 'e1', modeles);
    expect(s.publication_ok).toBe(true);
    expect(s.dernier).toBe('2026-11-07T10:00:00Z séquence vert (e1)');
  });
  it('une séquence ne compte ni comme court, ni comme rouge d\'un court ; un éclair rouge après le court bloque toujours', () => {
    expect(ok([court(), sequence({ vert: false }), sequence({ run: 'run2' })])).toBe(true);
    expect(ok([court(), sequence(), court({ bancs: ['1-a'], eclair_ok: false })])).toBe(false);
  });
});
