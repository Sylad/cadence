import { describe, expect, it } from 'vitest';
import type { Mesure } from '../src/bench/bras.js';
import type { Jugement, Meca } from '../src/bench/juges.js';
import { BARRE_SPEC, ligneHistorique, rapport, statut, verdict, type ResultatBanc } from '../src/bench/verdict.js';

const mes = (bras: string, duree_s: number, questions = 0, echec: string | null = null): Mesure =>
  ({ bras, banc: 'b', debut: '', fin: '', duree_s, tokens: 1000, cout_usd: 1, questions, questions_texte: [], sessions: [], echec });
const meca = (p: number, t: number): Meca => ({ suite_ok: true, caches_passes: p, caches_total: 10, mutations_tuees: t, mutations_total: 10, attendu: 'oui', mutations: [] });
function banc(o: Partial<{ dA: number; dC: number; cA: number; cC: number; mA: number; mC: number; majA: number; majC: number; pref: string; ui: string;
  taille: 'retouche' | 'fonction'; qC: number; reponses: boolean; fuiteC: string[]; nonJuge: boolean; echecA: string; echecC: string }> = {}): ResultatBanc {
  const j: Jugement = { meca: { A: meca(o.cA ?? 8, o.mA ?? 8), C: meca(o.cC ?? 8, o.mC ?? 8) },
    defauts: { A: { bloquants: 0, majeurs: o.majA ?? 0, mineurs: 0 }, C: { bloquants: 0, majeurs: o.majC ?? 0, mineurs: 0 } },
    prefere: o.pref ?? 'egal', ui: o.ui ?? 'na', raisons: '' };
  return { banc: 'b', taille: o.taille ?? 'fonction', visible: false, reponses: o.reponses ?? false, frais: false,
    mesures: { A: mes('A', o.dA ?? 100, 0, o.echecA ?? null), C: mes('C', o.dC ?? 100, o.qC ?? 0, o.echecC ?? null) },
    jugement: o.nonJuge ? null : j, fuites: { A: [], C: o.fuiteC ?? [] } };
}
const rouges = (r: ResultatBanc[]) => verdict(r, 'A', 'C', BARRE_SPEC).criteres.filter((c) => c.bloquant && !c.ok).map((c) => c.nom);

describe('verdict', () => {
  it('égalité partout : vert', () => expect(verdict([banc(), banc()], 'A', 'C', BARRE_SPEC).vert).toBe(true));
  it('temps 1,6 × A : rouge sur le temps', () => expect(rouges([banc({ dC: 160 })])).toEqual(['temps total']));
  it('retouche à 1,3 × A : rouge sur les retouches', () => expect(rouges([banc({ taille: 'retouche', dC: 130 }), banc({ dA: 1000, dC: 900 })])).toEqual(['temps des retouches']));
  it('A préféré sur la majorité : rouge', () => expect(rouges([banc({ pref: 'A' }), banc({ pref: 'A' }), banc({ pref: 'C' })])).toEqual(['relecture aveugle']));
  it('moins de tests cachés ou de mutations tuées : rouge', () => {
    expect(rouges([banc({ cC: 7 })])).toEqual(['tests cachés']);
    expect(rouges([banc({ mC: 7 })])).toEqual(['mutations tuées']);
  });
  it('plus de défauts bloquants + majeurs : rouge', () => expect(rouges([banc({ majC: 1 })])).toEqual(['défauts bloquants et majeurs']));
  it('UI : A plus souvent préféré que le candidat : rouge', () => expect(rouges([banc({ ui: 'A' })])).toEqual(['cohérence UI']));
  it('question sur un banc sans vraie décision : rouge ; avec réponses.md : permis', () => {
    expect(rouges([banc({ qC: 1 })])).toEqual(['questions inutiles']);
    expect(rouges([banc({ qC: 1, reponses: true })])).toEqual([]);
  });
  it('fuite du candidat : rouge', () => expect(rouges([banc({ fuiteC: ['/h/projects/x'] })])).toEqual(['aucune fuite']));
  it('banc non jugé : rouge, jamais vert par défaut', () => expect(rouges([banc({ nonJuge: true })])).toEqual(['tous les bancs jugés']));
  it('bras candidat en échec : rouge sur cette seule barre, cause listée', () => {
    const v = verdict([banc({ echecC: 'code 1' })], 'A', 'C', BARRE_SPEC);
    expect(rouges([banc({ echecC: 'code 1' })])).toEqual(['aucun bras en échec']);
    expect(v.criteres.find((c) => c.nom === 'aucun bras en échec')).toMatchObject({ seuil: '0', valeur: 'b/C : code 1' });
  });
  it('référence en échec : rouge aussi, comparaison sans sens', () => {
    expect(rouges([banc({ echecA: 'sortie illisible' })])).toEqual(['aucun bras en échec']);
  });
  it('aucun banc : rouge', () => expect(rouges([])).toEqual(['au moins un banc']));
  it('mesure manquante : rouge, cause listée', () => {
    const b = banc(); delete b.mesures.C;
    const v = verdict([b], 'A', 'C', BARRE_SPEC);
    expect(v.criteres.find((c) => c.nom === 'mesures complètes')).toMatchObject({ ok: false, valeur: 'b/C' });
    expect(v.vert).toBe(false);
  });
  it('aucune mutation jouée : rouge', () => {
    const v = verdict([banc({ mA: 0, mC: 0 })], 'A', 'C', BARRE_SPEC);
    const b = banc(); b.jugement!.meca.A.mutations_total = 0; b.jugement!.meca.C.mutations_total = 0;
    expect(rouges([b])).toEqual(['mutations tuées']);
    expect(verdict([b], 'A', 'C', BARRE_SPEC).criteres.find((c) => c.nom === 'mutations tuées')?.valeur).toBe('aucune mutation jouée');
    expect(v.vert).toBe(true);
  });
  it('sans banc de retouche : critère non bloquant, valeur dite', () => {
    const c = verdict([banc({ dC: 100 })], 'A', 'C', BARRE_SPEC).criteres.find((x) => x.nom === 'temps des retouches');
    expect(c).toMatchObject({ bloquant: false, ok: true, valeur: 'aucun banc de retouche' });
    expect(verdict([banc({ taille: 'retouche' })], 'A', 'C', BARRE_SPEC).criteres.find((x) => x.nom === 'temps des retouches')?.bloquant).toBe(true);
  });
  it('les chiffres absolus du 07-11 sont affichés sans bloquer', () => {
    const v = verdict([banc()], 'A', 'C', BARRE_SPEC);
    expect(v.criteres.find((c) => c.nom === 'tests cachés (07-11 : 304)')).toMatchObject({ ok: false, bloquant: false });
    expect(v.vert).toBe(true);
  });
});

describe('rapport, historique, statut', () => {
  it('le rapport dit le verdict et nomme les critères rouges', () => {
    const r = [banc({ dC: 160 })];
    const md = rapport(r, 'A', 'C', verdict(r, 'A', 'C', BARRE_SPEC), { date: '2026-11-08', empreinte: 'abc' });
    expect(md).toMatch(/ROUGE/);
    expect(md).toMatch(/temps total/);
    expect(md).not.toMatch(/Questions posées/);
  });
  it('le rapport liste les questions posées par les bras', () => {
    const r = [banc()];
    r[0].mesures.C.questions_texte = ['Quel format de date ?'];
    const md = rapport(r, 'A', 'C', verdict(r, 'A', 'C', BARRE_SPEC), { date: '2026-11-08', empreinte: 'abc' });
    expect(md).toMatch(/## Questions posées/);
    expect(md).toContain('- b/C : Quel format de date ?');
  });
  const h = (date: string, vert: boolean, empreinte = 'e1', hebdo = true) =>
    ligneHistorique({ vert, criteres: [] }, { date, empreinte, candidat: 'C', bancs: ['1-a', '3-b', '6-c'], hebdo, frais: 0 });
  it('publication : un vert partiel (banc 1 seul) ne suffit pas, empreinte inconnue refusée', () => {
    const partiel = ligneHistorique({ vert: true, criteres: [] }, { date: '2026-11-07T10:00:00Z', empreinte: 'e1', candidat: 'C', bancs: ['1-a'], hebdo: false, frais: 0 });
    expect(statut([partiel], new Date('2026-11-09T08:00:00Z'), 'e1').publication_ok).toBe(false);
    expect(statut([h('2026-11-07T10:00:00Z', true, 'inconnue')], new Date('2026-11-09T08:00:00Z'), 'inconnue').publication_ok).toBe(false);
  });
  it('lundi sans passage depuis samedi : banc du weekend manquant', () => {
    const s = statut([h('2026-11-06T10:00:00Z', true)], new Date('2026-11-09T08:00:00Z'), 'e1');
    expect(s.banc_du_weekend).toBe(false);
  });
  it('passage samedi : banc du weekend fait ; publication seulement si vert sur la même empreinte', () => {
    const s = statut([h('2026-11-07T10:00:00Z', true, 'e1')], new Date('2026-11-09T08:00:00Z'), 'e1');
    expect(s).toMatchObject({ banc_du_weekend: true, publication_ok: true });
    expect(statut([h('2026-11-07T10:00:00Z', true, 'e1')], new Date('2026-11-09T08:00:00Z'), 'e2').publication_ok).toBe(false);
    expect(statut([h('2026-11-07T10:00:00Z', false, 'e1')], new Date('2026-11-09T08:00:00Z'), 'e1').publication_ok).toBe(false);
  });
  it('un banc court le samedi ne compte pas comme banc du weekend', () => {
    expect(statut([h('2026-11-07T10:00:00Z', true, 'e1', false)], new Date('2026-11-09T08:00:00Z'), 'e1').banc_du_weekend).toBe(false);
  });
  it('samedi 00 h 30 à Paris (vendredi 23 h 30 UTC) compte comme le weekend', () => {
    expect(statut([h('2026-11-13T23:30:00Z', true)], new Date('2026-11-16T08:00:00Z'), 'e1').banc_du_weekend).toBe(true);
  });
  it('en plein weekend, avant le passage : pas encore manquant', () => {
    expect(statut([], new Date('2026-11-08T08:00:00Z'), 'e1').banc_du_weekend).toBe(true);
  });
});
