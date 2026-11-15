import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur, Mesure } from '../src/bench/bras.js';
import { passage } from '../src/bench/cli.js';
import { BARRE_SPEC, rapport, verdictSansJuge, type ResultatBanc } from '../src/bench/verdict.js';
import { dossierTemp } from './temp.js';

// L734 (vécu du 15-11, banc mécanique, banc 1, bras cadence-run) : 28 findBy expirés à ~1 s sous la charge des 3 bancs en parallèle (suite 19,9 s
// contre 11,7 s) ; au calme, 68/68 deux fois et la suite complète verte. Une suite rouge d'un bras est rejouée seule, après la fin des autres bancs
// du passage, avant d'être comptée : verte au rejeu, elle compte verte avec la mention « rejoué » ; rouge au rejeu, elle reste rouge.
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
const sortie = JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} });
const base = { ref: 'A', cand: 'cadence-run', hebdo: false, juge: 'opus', maintenant: new Date('2026-11-15T15:00:00Z'), empreinte: 'e1' };
const prepReel = (await import('../src/bench/preparer.js')).preparer;
const RUN = '2026-11-15-1600-e1';
/** Suite rouge à ses deux premiers appels dans un clone (tests de la base, puis suite du bras), verte ensuite : le rouge de charge du 15-11. */
const ROUGE_SOUS_CHARGE = 'f=../$(basename $PWD).appels; n=$(cat $f 2>/dev/null || echo 0); echo $((n+1)) > $f; [ $n -ge 2 ]';
/** Le clone c2 (cadence-run au banc 1) prend `suite`, c1 (A) est vert. */
const seulC2 = (suite: string) => `[ "$(basename $PWD)" = c1 ] || { ${suite}; }`;

function racine(bancs: Record<string, string>): string {
  const r = dossierTemp('banc-l734-'), src = join(r, 'source');
  mkdirSync(src); git(src, 'init', '-q', '-b', 'main'); writeFileSync(join(src, 'a.txt'), 'a'); git(src, 'add', '.'); git(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  for (const [id, tests] of Object.entries(bancs)) {
    mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), `projet: p\nsource: ${src}\nbase: ${git(src, 'rev-parse', 'HEAD')}\ninstall: "true"\ntests: ${JSON.stringify(tests)}\ntaille: grosse\n`);
    writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd');
  }
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\ncadence-run:\n  modele: opus\n  brief: ${BRIEF}\n`);
  return r;
}
const livrer: Executeur = (_a, o) => {
  mkdirSync(join(o.cwd, 'src'), { recursive: true }); writeFileSync(join(o.cwd, 'src', 'x.ts'), 'x');
  git(o.cwd, 'add', '-A'); git(o.cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bras');
  return { stdout: sortie, code: 0 };
};
const jouer = async (bancs: Record<string, string>) => {
  const r = racine(bancs); const sorties: string[] = [];
  const v = await passage({ ...base, racine: r, numeros: Object.keys(bancs).map((b) => b.split('-')[0]), niveau: 'mecanique', exec: livrer, prep: prepReel, home: r, out: (x) => sorties.push(x) });
  return { r, v, sorties, rapport: readFileSync(join(r, 'rapports', `${RUN}.md`), 'utf8') };
};

describe('passage mécanique : une suite rouge est rejouée seule, après les autres bancs (L734)', () => {
  it('le cas du 15-11 : rouge sous charge, verte au rejeu → comptée verte, « rejoué » au rapport', async () => {
    const { r, v, sorties, rapport: md } = await jouer({ '1-a': seulC2(ROUGE_SOUS_CHARGE), '3-b': 'true' });
    expect(v.vert).toBe(true);
    expect(v.criteres.find((c) => c.nom === 'suite du projet verte')).toMatchObject({ valeur: '2 contre 2 bancs', ok: true });
    // rejoué après la fin de tous les bancs du passage, pas pendant
    const rejeu = sorties.findIndex((l) => l.startsWith('1-a : suite de cadence-run rouge pendant les autres bancs, rejouée seule'));
    expect(rejeu).toBeGreaterThan(sorties.findIndex((l) => l.startsWith('3-b : bras ')));
    expect(md).toMatch(/\| 1-a \|.*\| ok · ok \(rejoué\) \|/);
    expect(md).toContain('- 1-a/cadence-run : vert au rejeu seul (sous charge : suite ROUGE, tests d\'origine –)');
    const d = join(r, 'runs', RUN, '1-a');
    expect(JSON.parse(readFileSync(join(d, 'resultat.json'), 'utf8')).sans_juge['cadence-run']).toEqual({ suite_ok: true, caches_ok: null, rejoue: { suite_ok: false, caches_ok: null } });
    expect([existsSync(join(d, 'c2.tests-bras.log')), existsSync(join(d, 'c2.tests-bras.rejeu.log'))]).toEqual([true, true]); // le journal sous charge reste
    expect([existsSync(join(d, 'c2')), existsSync(join(d, 'c2.patch'))]).toEqual([false, true]); // archivé après le rejeu
  });
  it('rouge au rejeu : reste rouge, avec la mention', async () => {
    const { v, rapport: md } = await jouer({ '1-a': seulC2('false') });
    expect(v.vert).toBe(false);
    expect(v.criteres.find((c) => c.nom === 'suite du projet verte')).toMatchObject({ valeur: '0 contre 1 bancs', ok: false });
    expect(md).toMatch(/\| 1-a \|.*\| ok · ROUGE \(rejoué\) \|/);
    expect(md).toContain('- 1-a/cadence-run : ROUGE au rejeu seul');
  });
  it('suites vertes : rien n\'est rejoué', async () => {
    const { sorties, rapport: md } = await jouer({ '1-a': 'true' });
    expect(sorties.join('\n')).not.toContain('rejouée seule');
    expect(md).not.toContain('Suites rejouées');
  });
});

describe('verdict sans juge : la mesure rejouée compte, celle sous charge ne compte plus (L734)', () => {
  const m: Mesure = { bras: 'x', banc: '', debut: '', fin: '', duree_s: 10, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null };
  const r: ResultatBanc = { banc: '1-a', taille: 'fonction', visible: false, reponses: false, frais: false, mesures: { A: m, 'cadence-run': m }, jugement: null,
    fuites: { A: [], 'cadence-run': [] }, sans_juge: { A: { suite_ok: true, caches_ok: true }, 'cadence-run': { suite_ok: true, caches_ok: true, rejoue: { suite_ok: false, caches_ok: true } } } };
  it('vert, et la cellule des tests d\'origine, verts sous charge, ne porte pas la mention', () => {
    const v = verdictSansJuge([r], 'A', 'cadence-run', BARRE_SPEC);
    expect(v.vert).toBe(true);
    expect(rapport([r], 'A', 'cadence-run', v, { date: '2026-11-15', empreinte: 'e1' })).toMatch(/\| ok · ok \| – \| ok · ok \(rejoué\) \|/);
  });
});
