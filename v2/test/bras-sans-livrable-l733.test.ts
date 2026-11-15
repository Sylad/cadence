import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur, Mesure } from '../src/bench/bras.js';
import { passage } from '../src/bench/cli.js';
import { sansLivrable } from '../src/bench/sans-juge.js';
import { BARRE_SPEC, PUBLIE, statut, verdictSansJuge, type ResultatBanc } from '../src/bench/verdict.js';
import { dossierTemp } from './temp.js';

// L733 (vécu des 14 et 15-11, banc 6-ol-companion-L167) : le bras A a fini en 75 s et 90 s en n'écrivant qu'une note de faisabilité dans le plan,
// sans implémenter ; le banc mécanique, sans juge, a compté ce temps comme une victoire (rouge ×2,0 en temps). Un bras qui ne livre aucun fichier
// hors plan et doc rend le banc non mesurable, à rejouer : ni vert ni rouge.
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
const sortie = JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} });
const base = { ref: 'A', cand: 'cadence-run', hebdo: false, juge: 'opus', maintenant: new Date('2026-11-15T15:00:00Z'), empreinte: 'e1', out: () => {} };
const prepReel = (await import('../src/bench/preparer.js')).preparer;
const RUN = '2026-11-15-1600-e1';

function racine(bancs: string[]): string {
  const r = dossierTemp('banc-l733-'), src = join(r, 'source');
  mkdirSync(src); git(src, 'init', '-q', '-b', 'main'); writeFileSync(join(src, 'a.txt'), 'a'); git(src, 'add', '.'); git(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  for (const id of bancs) {
    mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), `projet: p\nsource: ${src}\nbase: ${git(src, 'rev-parse', 'HEAD')}\ninstall: "true"\ntests: "true"\ntaille: grosse\n`);
    writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd');
  }
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\ncadence-run:\n  modele: opus\n  brief: ${BRIEF}\n`);
  return r;
}
const commit = (cwd: string, ...fichiers: string[]) => {
  for (const f of fichiers) { mkdirSync(dirname(join(cwd, f)), { recursive: true }); writeFileSync(join(cwd, f), 'x'); }
  git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bras');
};
/** Le plan du projet mesuré (ol-companion), écrit en morceaux : raf migrate lirait sinon ce test comme un lecteur du plan de cadence (test/migrate.test.ts, R7). */
const PLAN = ['docs', 'plan', 'raf.yaml'].join('/');
/** Ce qu'a commité le bras A du banc 6 le 15-11 : le registre et une note dans le plan, rien d'autre. */
const NOTE_DE_FAISABILITE = ['.cadence/demandes/D-1.json', PLAN];
const CODE = ['frontend/src/routes/equipe-de-france-match.tsx', PLAN];

describe('sansLivrable : un bras qui n\'écrit que du plan ou de la doc n\'a pas livré (L733)', () => {
  const depot = () => { const d = dossierTemp('livrable-l733-'); git(d, 'init', '-q', '-b', 'main'); commit(d, 'a.txt'); return { d, b: git(d, 'rev-parse', 'HEAD') }; };
  it('registre et plan seulement : la raison nomme les fichiers', () => {
    const { d, b } = depot(); commit(d, ...NOTE_DE_FAISABILITE);
    expect(sansLivrable(d, b)).toBe(`aucun fichier livré hors plan et doc (seulement .cadence/demandes/D-1.json, ${PLAN})`);
  });
  it('docs, Markdown, cadence.yaml et captures MCP ne comptent pas non plus', () => {
    const { d, b } = depot(); commit(d, 'docs/qa/expectations.md', 'CLAUDE.md', 'cadence.yaml', '.playwright-mcp/x.png', 'docs/archi.txt');
    expect(sansLivrable(d, b)).toMatch(/^aucun fichier livré hors plan et doc/);
  });
  it('un fichier de code, même accompagné du plan : livré', () => {
    const { d, b } = depot(); commit(d, ...CODE);
    expect(sansLivrable(d, b)).toBeNull();
  });
});

describe('passage mécanique : un bras sans livrable rend le banc non mesurable (L733)', () => {
  const jouer = async (livreA: string[], livreCand: string[]) => {
    const r = racine(['6-c']); const sorties: string[] = [];
    const exec: Executeur = (_a, o) => { commit(o.cwd, ...(o.cwd.endsWith('c1') ? livreA : livreCand)); return { stdout: sortie, code: 0 }; }; // banc 6 seul : c1 = A
    const v = await passage({ ...base, racine: r, numeros: ['6'], niveau: 'mecanique', exec, prep: prepReel, home: r, out: (x) => sorties.push(x) });
    return { r, v, sorties };
  };
  it('le cas du 15-11 : A n\'écrit qu\'une note de faisabilité, cadence-run implémente → ni vert ni rouge, à rejouer', async () => {
    const { r, v, sorties } = await jouer(NOTE_DE_FAISABILITE, CODE);
    expect(v.non_mesurable).toEqual(['6-c']);
    expect(v.vert).toBe(false);
    expect(v.criteres.find((c) => c.nom === 'temps total')?.valeur).toBe('0 s contre 0 s'); // le temps du banc ne compte ni en victoire ni en défaite
    expect(v.criteres.find((c) => c.nom === 'bras qui ont livré le travail')).toMatchObject({ ok: false, valeur: `6-c/A : aucun fichier livré hors plan et doc (seulement .cadence/demandes/D-1.json, ${PLAN})` });
    expect(existsSync(join(r, 'runs', RUN, '6-c', 'c1.tests-bras.log'))).toBe(false); // mesure sautée
    const res = JSON.parse(readFileSync(join(r, 'runs', RUN, '6-c', 'resultat.json'), 'utf8'));
    expect(res.non_livre).toEqual({ A: expect.stringMatching(/^aucun fichier livré hors plan et doc/) });
    expect(res.sans_juge).toBeUndefined();
    const rap = readFileSync(join(r, 'rapports', `${RUN}.md`), 'utf8');
    expect(rap.split('\n')[0]).toBe('# Banc 2026-11-15 — cadence-run contre A — NON MESURABLE (à rejouer)');
    expect(rap).toMatch(/## Bancs non mesurables\n\n.*Rejouer le passage\.\n\n- 6-c\/A : aucun fichier livré/);
    expect(rap).toMatch(/\| 6-c \|.*\| non mesurable \|/);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8'))).toMatchObject({ niveau: 'mecanique', vert: false, non_mesurable: ['6-c'] });
    expect(sorties.join('\n')).toMatch(/6-c : banc non mesurable, à rejouer \(A : aucun fichier livré/);
    expect(sorties.at(-1)).toMatch(/^NON MESURABLE \(à rejouer\) — /);
  });
  it('symétrique : le candidat sans livrable ne gagne pas non plus', async () => {
    const { v } = await jouer(CODE, NOTE_DE_FAISABILITE);
    expect(v.non_mesurable).toEqual(['6-c']);
    expect(v.criteres.find((c) => c.nom === 'bras qui ont livré le travail')?.valeur).toMatch(/^6-c\/cadence-run : /);
  });
  it('les deux bras livrent du code : mesuré comme avant, pas de critère de livraison', async () => {
    const { v } = await jouer(CODE, CODE);
    expect(v.non_mesurable).toBeUndefined();
    expect(v.vert).toBe(true);
    expect(v.criteres.map((c) => c.nom)).not.toContain('bras qui ont livré le travail');
  });
});

describe('verdict sans juge : le banc non livré sort des critères, les autres restent mesurés (L733)', () => {
  const m = (duree_s: number): Mesure => ({ bras: 'x', banc: '', debut: '', fin: '', duree_s, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null });
  const r = (banc: string, a: number, c: number, x: Partial<ResultatBanc> = {}): ResultatBanc => ({ banc, taille: 'fonction', visible: false, reponses: false, frais: false,
    mesures: { A: m(a), 'cadence-run': m(c) }, jugement: null, fuites: { A: [], 'cadence-run': [] }, sans_juge: { A: { suite_ok: true, caches_ok: null }, 'cadence-run': { suite_ok: true, caches_ok: null } }, ...x });
  it('banc 6 à 75 s contre 719 s non livré, bancs 1 et 3 mesurés : le temps total ne compte que 1 et 3', () => {
    const v = verdictSansJuge([r('1-a', 169, 182), r('3-b', 489, 655), r('6-c', 75, 719, { sans_juge: undefined, non_livre: { A: 'aucun fichier livré hors plan et doc' } })], 'A', 'cadence-run', BARRE_SPEC);
    expect(v.criteres.find((c) => c.nom === 'temps total')).toMatchObject({ valeur: '837 s contre 658 s', ok: true });
    expect(v.criteres.find((c) => c.nom === 'bancs mesurés sans juge')).toMatchObject({ valeur: '2/2', ok: true });
    expect(v).toMatchObject({ vert: false, non_mesurable: ['6-c'] });
  });
});

describe('garde : un passage non mesurable n\'est ni vert ni rouge (L733)', () => {
  const now = new Date('2026-11-15T18:00:00Z');
  const l = (o: Record<string, unknown> = {}) => JSON.stringify({ date: '2026-11-15T15:00:00Z', empreinte: 'e1', candidat: 'cadence-run', reference: 'A', modele_candidat: 'opus',
    bancs: ['1-a', '3-b', '6-c'], hebdo: false, frais: 0, vert: true, rouges: [], niveau: 'mecanique', ...o });
  const nm = l({ date: '2026-11-15T16:00:00Z', vert: false, rouges: ['bras qui ont livré le travail'], non_mesurable: ['6-c'] });
  const s = (h: string[]) => statut(h, now, 'e1', { 'cadence-run': 'opus', A: 'opus' }, PUBLIE);
  it('après un mécanique vert, un non mesurable ne retire pas la publication ; seul, il ne la donne pas', () => {
    expect(s([l(), nm]).publication_ok).toBe(true);
    expect(s([nm]).publication_ok).toBe(false);
  });
  it('le dernier passage se lit « non mesurable », pas « rouge »', () => {
    expect(s([l(), nm]).dernier).toBe('2026-11-15T16:00:00Z mecanique non mesurable (e1)');
  });
});
