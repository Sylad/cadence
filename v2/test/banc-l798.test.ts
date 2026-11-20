import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { horlogeAPas, passage } from '../src/bench/cli.js';
import { preparer as prep } from '../src/bench/preparer.js';
import { dossierTranscripts, fuiteSansEffet, trierFuitesReference } from '../src/bench/fuites.js';
import { etatTestJest, exclureTests, mesurerSansJuge, TESTS_HORS_COMPTE, testReussiJest } from '../src/bench/sans-juge.js';
import { BARRE_SPEC, FUITES_SIGNALEES, rapport, verdictSansJuge, type ResultatBanc } from '../src/bench/verdict.js';
import { dossierTemp } from './temp.js';

// L798 : banc mécanique du 20-11 11:11 (rapport 2026-11-20-1111-5b216e39b20b) rouge sur deux critères sans lien avec le candidat.
// (1) « 80 contre 81 » : seul écart au banc 3, jest 31 contre 32. Le test qui bascule n'est pas du bruit : il suit le chemin d'écriture choisi par le bras.
// (2) « aucune fuite » rouge pour une écriture du bras A à côté de son propre clone (`c2.tsc.txt`).

const SPEC = 'standings.service.rankings.cache-banc.spec.ts';
const T = 'StandingsService — tracker de classement recalculé (L241)';
const T503 = `${T} › résultats de la ligue en échec (HTTP 503) : le tracé existant est conservé`;
const T1 = `${T} › écrit une entrée par journée, OL 1er à l'issue de la J7, et le dit sur le flux d'événements`;
const T2 = `${T} › remplace un ancien fichier faux (photo en cours de journée : J7 en 4e) sans rien garder`;
const RATE_SUITE = 'FAIL src/modules/standings/season-rankings.cache-banc.spec.ts\n  ● Test suite failed to run\n\n    Cannot find module \'./season-rankings\'';
/** Extraits des journaux `c1|c2.tests-origine.log` du banc 3, 20-11 (identiques au rejeu) : c1 = cadence-run, c2 = A. */
const CADENCE_RUN = `${RATE_SUITE}\n\x1b[32m[Nest] 392312  - \x1b[39mLOG\nFAIL src/modules/standings/${SPEC}\n  ● ${T1}\n\n    ENOENT\n  ● ${T2}\n\n    Expected: 1\n  ● ${T503}\n
    ENOENT: no such file or directory, open '/tmp/ol-standings-l241-w527mi/data/season-rankings.json'\nFAIL src/config/scores365-host.cache-banc.spec.ts\n  ● x › y
Summary of all failing tests\nFAIL modules/standings/${SPEC}\n  ● ${T1}\n  ● ${T503}\nTest Suites: 3 failed, 50 passed, 53 total\nTests:       4 failed, 559 passed, 563 total`;
const A = `${RATE_SUITE}\nFAIL src/modules/standings/${SPEC}\n  ● ${T1}\n\n    - Expected  - 32\n  ● ${T2}\nFAIL src/config/scores365-host.cache-banc.spec.ts\n  ● x › y
Summary of all failing tests\nFAIL modules/standings/${SPEC}\n  ● ${T1}\n  ● ${T2}\nTest Suites: 3 failed, 50 passed, 53 total\n\x1b[1mTests:\x1b[22m       3 failed, 556 passed, 559 total`;

describe('tests d\'origine hors compte (L798)', () => {
  it('le test qui bascule au banc 3 : raté par cadence-run (ENOENT), réussi par A', () => {
    expect(testReussiJest(CADENCE_RUN, SPEC, T503)).toBe(false);
    expect(testReussiJest(A, SPEC, T503)).toBe(true);
    expect(testReussiJest(A, SPEC, T1)).toBe(false);
  });
  it('un fichier qui n\'a pas tourné, ou un journal sans bilan jest, ne donne pas un test réussi', () => {
    expect(testReussiJest(`${RATE_SUITE}\nTests:       1 failed, 3 passed, 4 total`, 'season-rankings.cache-banc.spec.ts', 'a › b')).toBe(false);
    expect(testReussiJest(A.replace(/Tests:.*$/m, ''), SPEC, T503)).toBe(false);
    // revue r1 : le fichier absent du journal (hors du testMatch du bras, par exemple) n'a pas tourné : inconnu, pas réussi
    const sansFichier = A.split('\n').filter((l) => !l.includes(SPEC)).join('\n');
    expect(etatTestJest(sansFichier, SPEC, T503)).toBe('inconnu'); expect(testReussiJest(sansFichier, SPEC, T503)).toBe(false);
    expect(etatTestJest(A.replace(/Tests:.*$/m, ''), SPEC, T503)).toBe('inconnu');
    expect(etatTestJest(`PASS src/modules/standings/${SPEC}\nTests:       3 passed, 3 total`, SPEC, T503)).toBe('réussi');
    expect(etatTestJest(CADENCE_RUN, SPEC, T503)).toBe('raté');
    const x = exclureTests({ par_lanceur: { jest: 32 }, hors_compte: [] }, sansFichier, TESTS_HORS_COMPTE['3-ol-companion-L241']);
    expect(x.par_lanceur).toEqual({ jest: 32 }); expect(x.hors_compte).toEqual([expect.stringContaining(', inconnu) : ')]);
  });
  it('la liste est écrite, avec sa raison, et ne vise que le banc 3', () => {
    expect(Object.keys(TESTS_HORS_COMPTE)).toEqual(['3-ol-companion-L241']);
    expect(TESTS_HORS_COMPTE['3-ol-companion-L241']).toEqual([expect.objectContaining({ lanceur: 'jest', fichier: SPEC, nom: T503, raison: expect.stringMatching(/chemin d'écriture/) })]);
  });
  it('le 20-11 : 31 contre 32 devient 31 contre 31 ; le test est nommé hors compte pour les deux bras, réussi ou raté', () => {
    const x = TESTS_HORS_COMPTE['3-ol-companion-L241'];
    const cand = exclureTests({ par_lanceur: { jest: 31 }, hors_compte: ['vitest : absent de la suite avec les tests d\'origine'] }, CADENCE_RUN, x);
    const ref = exclureTests({ par_lanceur: { jest: 32 }, hors_compte: [] }, A, x);
    expect(cand.par_lanceur).toEqual({ jest: 31 }); expect(ref.par_lanceur).toEqual({ jest: 31 });
    expect(cand.hors_compte).toEqual(['vitest : absent de la suite avec les tests d\'origine',
      expect.stringMatching(/^jest : « résultats de la ligue en échec \(HTTP 503\) : le tracé existant est conservé » \(standings\.service\.rankings\.cache-banc\.spec\.ts, raté\) : /)]);
    expect(ref.hors_compte).toEqual([expect.stringContaining(', réussi) : ')]);
  });
  it('sans affaiblir L777 : les autres tests comptent un par un, un lanceur hors compte reste hors compte', () => {
    // un autre test raté par le candidat seul garde l'écart d'un test
    const autre = exclureTests({ par_lanceur: { jest: 30 }, hors_compte: [] }, CADENCE_RUN, TESTS_HORS_COMPTE['3-ol-companion-L241']);
    expect(autre.par_lanceur.jest).toBe(30);
    expect(exclureTests({ par_lanceur: {}, hors_compte: ['jest : 3 rouge(s) dans la suite seule'] }, A, TESTS_HORS_COMPTE['3-ol-companion-L241']))
      .toEqual({ par_lanceur: {}, hors_compte: ['jest : 3 rouge(s) dans la suite seule'] });
  });
  it('mesurerSansJuge applique la liste du banc par son id, et seulement celle-là', () => {
    const r = dossierTemp('hors-compte-l798-'), clone = join(r, 'c1'), secrets = join(r, 'secrets');
    mkdirSync(join(secrets, 'tests-origine'), { recursive: true }); mkdirSync(clone); writeFileSync(join(secrets, 'tests-origine', 'o.test.sh'), '');
    const sortie = join(r, 'journal.txt'); writeFileSync(sortie, A);
    // la suite seule : 525 réussis ; avec les tests d'origine : le journal de A (556 réussis), soit 31 + le test 503
    const tests = `if ls *.cache-banc.test.sh >/dev/null 2>&1; then cat ${sortie}; else echo "Tests:       525 passed, 525 total"; fi`;
    const banc = (id: string) => ({ id, dir: r, secrets, projet: 'p', source: r, base: 'x', install: 'true', tests, visible: false, taille: 'fonction' as const, frais: false, reponses: false });
    expect(mesurerSansJuge(banc('3-ol-companion-L241'), clone)).toMatchObject({ caches_reussis: { jest: 30 }, caches_hors_compte: [expect.stringContaining('réussi')] });
    expect(mesurerSansJuge(banc('1-ol-companion-L239'), clone)).toEqual({ suite_ok: true, caches_ok: true, caches_reussis: { jest: 31 } });
  });
});

const RUNS = '/h/bench-cadence/runs/2026-11-20-1111-5b216e39b20b', BANC = `${RUNS}/7-ol-companion-L160`;

describe('fuite de la référence sans effet possible sur le candidat (L798)', () => {
  it('signalée : un fichier du dossier du banc, hors du clone du candidat et de ses voisins', () => {
    expect(fuiteSansEffet(`${BANC}/c2.tsc.txt`, BANC, `${BANC}/c1`)).toBe(true); // le cas du 20-11 : A (c2) écrit à côté de son clone
    expect(fuiteSansEffet(`${BANC}/c2.tsc.txt`, BANC, `${BANC}/c2`)).toBe(false); // même chemin, nommé d'après le clone du candidat
    for (const p of [`${BANC}/c1`, `${BANC}/c1/src/x.ts`, `${BANC}/c1.question.md`, `${BANC}/c1.captures/a.png`, `${BANC}/c1.tests-base.log`])
      expect(fuiteSansEffet(p, BANC, `${BANC}/c1`), p).toBe(false);
  });
  it('bloquante : hors du dossier du banc (secrets, autre banc, projets), le dossier lui-même (préfixe d\'un glob), un glob, un contournement', () => {
    for (const p of ['/h/bench-cadence/secrets/7-ol-companion-L160', `${RUNS}/3-ol-companion-L241/c2.x`, '/h/projects/ol', BANC, `${BANC}/c*`, `${BANC}x/c2.y`,
      'contournement : Bash {"command":"rm hooks"}']) expect(fuiteSansEffet(p, BANC, `${BANC}/c1`), p).toBe(false);
  });
  it('trierFuitesReference sépare les deux quand la référence a joué après le candidat ; jouée avant, tout reste bloquant (revue r1)', () => {
    expect(trierFuitesReference([`${BANC}/c2.tsc.txt`, '/h/bench-cadence/secrets/x'], BANC, `${BANC}/c1`, true))
      .toEqual({ bloquantes: ['/h/bench-cadence/secrets/x'], signalees: [`${BANC}/c2.tsc.txt`] });
    expect(trierFuitesReference([`${BANC}/c1.tsc.txt`, '/h/bench-cadence/secrets/x'], BANC, `${BANC}/c2`, false))
      .toEqual({ bloquantes: [`${BANC}/c1.tsc.txt`, '/h/bench-cadence/secrets/x'], signalees: [] });
  });

  const m = (bras: string) => ({ bras, banc: 'x', debut: '', fin: '', duree_s: 100, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null });
  const r = (o: Partial<ResultatBanc>): ResultatBanc => ({ banc: '7-ol-companion-L160', taille: 'fonction', visible: false, reponses: false, frais: false,
    mesures: { A: m('A'), 'cadence-run': m('cadence-run') }, jugement: null, fuites: { A: [], 'cadence-run': [] },
    sans_juge: { A: { suite_ok: true, caches_ok: false, caches_reussis: { vitest: 16 } }, 'cadence-run': { suite_ok: true, caches_ok: false, caches_reussis: { vitest: 16 } } }, ...o });
  it('verdict : signalée, le passage reste vert ; le rapport la montre « signalé » ; une fuite bloquante ou du candidat rougit toujours', () => {
    const v = verdictSansJuge([r({ fuites_signalees: { A: [`${BANC}/c2.tsc.txt`] } })], 'A', 'cadence-run', BARRE_SPEC);
    expect(v.vert).toBe(true);
    expect(v.criteres.find((c) => c.nom === 'aucune fuite')).toMatchObject({ valeur: '0', ok: true });
    expect(v.criteres.find((c) => c.nom === FUITES_SIGNALEES)).toMatchObject({ valeur: `7-ol-companion-L160/A : ${BANC}/c2.tsc.txt`, ok: false, bloquant: false });
    const rap = rapport([r({ fuites_signalees: { A: [`${BANC}/c2.tsc.txt`] } })], 'A', 'cadence-run', v, { date: '2026-11-20', empreinte: 'e', repetitions: 1, niveau: 'mecanique' });
    expect(rap).toContain(`| ${FUITES_SIGNALEES} | 7-ol-companion-L160/A : ${BANC}/c2.tsc.txt | 0 (signalé) | **signalé** |`);
    expect(verdictSansJuge([r({})], 'A', 'cadence-run', BARRE_SPEC).criteres.some((c) => c.nom === FUITES_SIGNALEES)).toBe(false);
    expect(verdictSansJuge([r({ fuites: { A: ['/h/bench-cadence/secrets/x'], 'cadence-run': [] } })], 'A', 'cadence-run', BARRE_SPEC).vert).toBe(false);
    expect(verdictSansJuge([r({ fuites: { A: [], 'cadence-run': [`${BANC}/c1.tsc.txt`] } })], 'A', 'cadence-run', BARRE_SPEC).vert).toBe(false);
  });
});

describe('passage mécanique : le tri des fuites se fait au banc, la référence seulement, et seulement jouée après le candidat (L798)', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md'), RUN = '2026-11-20-1200-e1';
  const sortie = JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} });
  /** `refApres` : un passage antérieur du banc (rapport) fait alterner l'ordre (L737) : le candidat joue en c1, la référence en c2. */
  const jouer = async (commande: (bras: string) => string, refApres = false) => {
    const r = dossierTemp('fuites-l798-'), src = join(r, 'source'), id = '6-c';
    mkdirSync(src); git(src, 'init', '-q', '-b', 'main'); writeFileSync(join(src, 'a.txt'), 'a'); git(src, 'add', '.'); git(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), `projet: p\nsource: ${src}\nbase: ${git(src, 'rev-parse', 'HEAD')}\ninstall: "true"\ntests: "true"\ntaille: grosse\n`);
    writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd');
    // le modèle distingue les bras, quel que soit leur ordre
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\ncadence-run:\n  modele: sonnet\n  brief: ${BRIEF}\n`);
    if (refApres) { mkdirSync(join(r, 'rapports')); writeFileSync(join(r, 'rapports', '2026-11-19-1000-e0.json'), JSON.stringify({ resultats: [{ banc: id }] })); }
    const joues: string[] = [];
    const exec: Executeur = (a, o) => {
      const bras = a[a.indexOf('--model') + 1] === 'opus' ? 'A' : 'cadence-run', t = dossierTranscripts(r, o.cwd);
      joues.push(`${bras}@${o.cwd.slice(-2)}`);
      mkdirSync(t, { recursive: true });
      writeFileSync(join(t, 's.jsonl'), JSON.stringify({ type: 'assistant', cwd: o.cwd, message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: commande(bras) } }] } }));
      writeFileSync(join(o.cwd, 'x.ts'), bras); git(o.cwd, 'add', '-A'); git(o.cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bras');
      return { stdout: sortie, code: 0 };
    };
    const v = await passage({ ref: 'A', cand: 'cadence-run', hebdo: false, juge: 'opus', maintenant: new Date('2026-11-20T11:00:00Z'), empreinte: 'e1', out: () => {},
      horloge: horlogeAPas('2026-11-20T11:00:00Z', 60_000), racine: r, numeros: ['6'], niveau: 'mecanique', exec, prep, home: r });
    // l'ordre attendu a bien eu lieu
    expect(joues.filter((j, i) => joues.indexOf(j) === i)).toEqual(refApres ? ['cadence-run@c1', 'A@c2'] : ['A@c1', 'cadence-run@c2']);
    return { v, res: JSON.parse(readFileSync(join(r, 'runs', RUN, id, 'resultat.json'), 'utf8')), dossier: join(r, 'runs', RUN, id) };
  };
  it('A joue après le candidat (cas du banc 7 du 20-11 : A en c2) et écrit `../c2.tsc.txt` à côté de son clone : signalée, passage vert', async () => {
    const { v, res, dossier } = await jouer((b) => (b === 'A' ? 'npx tsc > ../c2.tsc.txt' : 'true'), true);
    expect(res.clones).toEqual({ c1: 'cadence-run', c2: 'A' });
    expect(res.fuites).toEqual({ A: [], 'cadence-run': [] }); expect(res.fuites_signalees).toEqual({ A: [join(dossier, 'c2.tsc.txt')] });
    expect(v.vert).toBe(true);
  });
  it('A joue avant le candidat et écrit `../c1.tsc.txt` : le candidat pouvait la lire (`grep -r ..`), bloquante, passage rouge (revue r1)', async () => {
    const { v, res, dossier } = await jouer((b) => (b === 'A' ? 'npx tsc > ../c1.tsc.txt' : 'grep -rn error ..'));
    expect(res.clones).toEqual({ c1: 'A', c2: 'cadence-run' });
    expect(res.fuites.A).toEqual([join(dossier, 'c1.tsc.txt')]); expect(res.fuites_signalees).toBeUndefined();
    expect(v.vert).toBe(false);
  });
  it('le candidat qui écrit à côté de son clone : rouge, dans les deux ordres', async () => {
    for (const refApres of [false, true]) {
      const c = refApres ? 'c1' : 'c2', cand = await jouer((b) => (b === 'A' ? 'true' : `npx tsc > ../${c}.tsc.txt`), refApres);
      expect(cand.res.fuites['cadence-run'], c).toEqual([join(cand.dossier, `${c}.tsc.txt`)]); expect(cand.res.fuites_signalees).toBeUndefined();
      expect(cand.v.vert).toBe(false);
    }
  });
  it('A écrit dans les fichiers du candidat : bloquante, dans les deux ordres', async () => {
    for (const refApres of [false, true]) {
      const c = refApres ? 'c1' : 'c2', { v, res, dossier } = await jouer((b) => (b === 'A' ? `echo oui > ../${c}.question.md` : 'true'), refApres);
      expect(res.fuites.A, c).toEqual([join(dossier, `${c}.question.md`)]); expect(v.vert).toBe(false);
    }
  });
});
