// L804 : le 21-11 à 12:04, le banc complet du samedi a été refusé pour un v2/dist périmé (v2/src plus récent que dist/cli.js) ; seul complet.log le disait.
// Le banc construit désormais v2 avant de mesurer, et tout refus du banc complet se voit dans `bench statut`, donc au tour du lead, avec sa cause.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tourBancLines } from '../../src/bench-tour.js';
import { bench } from '../src/bench/cli.js';
import { complet, type Construction } from '../src/bench/complet.js';
import { construireV2, distPerime, ENV_CONSTRUIT, FICHIER_REFUS, ligneRefus, relancerV2 } from '../src/bench/refus-complet.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

/** Un dépôt dont v2/dist/cli.js est plus vieux que v2/src : l'état du 21-11. */
function depotPerime(): string {
  const repo = dossierTemp('l804-depot-');
  mkdirSync(join(repo, 'v2', 'src', 'bench'), { recursive: true }); mkdirSync(join(repo, 'v2', 'dist'));
  writeFileSync(join(repo, 'v2', 'dist', 'cli.js'), 'ancien');
  writeFileSync(join(repo, 'v2', 'src', 'bench', 'cli.ts'), 'neuf');
  const vieux = new Date(Date.now() - 3_600_000); utimesSync(join(repo, 'v2', 'dist', 'cli.js'), vieux, vieux);
  return repo;
}
const racine = (...seqs: string[]) => { const r = dossierTemp('l804-banc-'); mkdirSync(join(r, 'sequences'), { recursive: true }); for (const s of seqs) mkdirSync(join(r, 'sequences', s)); return r; };

/** Le banc réel (bench court, séquences) remplacé : on ne mesure ici que l'enchaînement. */
const faux = (court = 0, erreur?: string) => {
  const appels: string[][] = [];
  return { appels, d: {
    bench: async (a: string[], io: { err: (l: string) => void }) => { appels.push(['bench', ...a]); if (a[0] === 'court' && erreur) io.err(erreur); return a[0] === 'court' ? court : 0; },
    sequence: async (a: string[]) => { appels.push(['sequence', ...a]); return 0; },
    bruit: async () => 0,
  } };
};

/** La construction réelle (distPerime) sur le dépôt donné ; construire et relancer notés. */
function construction(repo: string, o: { echec?: string; rafraichit?: boolean; code?: number } = {}) {
  const fait = { construit: 0, relances: [] as { args: string[]; env: NodeJS.ProcessEnv }[] };
  const c: Construction = { repo, perime: distPerime,
    construire: () => { fait.construit++; if (o.rafraichit !== false && !o.echec) { const t = new Date(Date.now() + 5000); utimesSync(join(repo, 'v2', 'dist', 'cli.js'), t, t); } return o.echec ?? null; },
    relancer: async (_r, args, env) => { fait.relances.push({ args, env }); return o.code ?? 0; } };
  return { c, fait };
}

describe('L804 : un v2/dist périmé est construit avant de mesurer', () => {
  it('reproduit le 21-11 : dist périmé → npm run build, puis relance du banc complet sur le dist neuf, sans mesurer avec l\'ancien code', async () => {
    const repo = depotPerime(), r = racine('s1');
    expect(distPerime(repo)).toMatch(/plus récent que v2\/dist\/cli\.js/);
    const { appels, d } = faux(); const { c, fait } = construction(repo, { code: 1 });
    const io = ioTest({ BENCH_ROOT: r, HOME: r });
    expect(await complet(['--sequences', 's1'], io, { ...d, construction: c })).toBe(1); // le code de la relance
    expect(fait.construit).toBe(1);
    expect(appels).toEqual([]); // rien mesuré par le processus qui tourne l'ancien dist
    expect(fait.relances).toEqual([{ args: ['bench', 'complet', '--sequences', 's1'], env: expect.objectContaining({ [ENV_CONSTRUIT]: '1', BENCH_ROOT: r }) }]);
    expect(io.sortie.join('\n')).toMatch(/construction de v2 \(npm run build\) avant de mesurer/);
    expect(distPerime(repo)).toBeNull();
  });
  it('la relance mesure quand dist est à jour, et refuse sans boucler si dist est encore périmé après la construction', async () => {
    const repo = depotPerime(), r = racine('s1');
    const { appels, d } = faux(); const { c, fait } = construction(repo);
    const enfant = ioTest({ BENCH_ROOT: r, HOME: r, [ENV_CONSTRUIT]: '1' });
    expect(await complet([], enfant, { ...d, construction: c })).toBe(2);
    expect(fait.construit).toBe(0); expect(appels).toEqual([]);
    expect(ligneRefus(r)).toMatch(/encore après la construction/);
    const t = new Date(Date.now() + 5000); utimesSync(join(repo, 'v2', 'dist', 'cli.js'), t, t);
    expect(await complet([], enfant, { ...d, construction: c })).toBe(0);
    expect(appels.map((a) => a[1])).toEqual(['court', 's1', 'statut']);
    expect(ligneRefus(r)).toBeNull(); // le banc a mesuré : l'ancien refus disparaît
  });
  it('construction en échec : code 2, aucune relance, cause dans le statut', async () => {
    const repo = depotPerime(), r = racine('s1');
    const { d } = faux(); const { c, fait } = construction(repo, { echec: 'src/x.ts(3,1): error TS2304' });
    expect(await complet([], ioTest({ BENCH_ROOT: r, HOME: r }), { ...d, construction: c })).toBe(2);
    expect(fait.relances).toEqual([]);
    expect(ligneRefus(r)).toMatch(/construction de v2 \(npm run build\) a échoué : src\/x\.ts\(3,1\): error TS2304/);
  });
});

describe('L804 : un échec du banc complet se voit au tour du lead, avec sa cause', () => {
  it('court refusé (code 2) : la cause écrite par le banc va dans le statut, le hook de démarrage et le tour', async () => {
    const r = racine('s1');
    const cause = 'bench refusé : /c/v2/src/bench/cli.ts est plus récent que v2/dist/cli.js : lancer « npm run build » dans v2';
    const { d } = faux(2, cause);
    expect(await complet([], { ...ioTest({ BENCH_ROOT: r, HOME: r }), now: () => new Date('2026-11-21T11:04:00Z') }, d)).toBe(2);
    expect(readFileSync(join(r, FICHIER_REFUS), 'utf8')).toBe(`2026-11-21T11:04:00.000Z\n${cause}\n`);
    const io = ioTest({ BENCH_ROOT: r, HOME: r });
    expect(await bench(['statut'], io, dossierTemp('l804-repo-'))).toBe(0);
    const ligne = io.sortie.find((l) => l.includes('non joué'));
    expect(ligne).toBe(`⚠ banc complet du 2026-11-21T11:04:00.000Z non joué : ${cause} ; corriger puis relancer « cadence2 bench complet » (journal : ~/bench-cadence/complet.log)`);
    // le tour du lead reprend les ⚠ qui nomment le banc complet (bench-tour.ts)
    const projet = dossierTemp('l804-projet-'); mkdirSync(join(projet, 'v2', 'bin'), { recursive: true }); mkdirSync(join(projet, 'v2', 'dist'));
    writeFileSync(join(projet, 'v2', 'bin', 'cadence2.js'), ''); writeFileSync(join(projet, 'v2', 'dist', 'cli.js'), '');
    const tour = tourBancLines([projet], {}, () => ({ code: 0, sortie: io.sortie.join('\n') }));
    expect(tour.some((l) => l.includes('non joué') && l.includes('plus récent que v2/dist/cli.js'))).toBe(true);
  });
  it('une erreur levée pendant le banc est notée puis relancée ; un banc qui mesure efface la trace', async () => {
    const r = racine('s1');
    const d = { ...faux().d, bench: async () => { throw new Error('disque plein'); } };
    await expect(complet([], ioTest({ BENCH_ROOT: r, HOME: r }), d)).rejects.toThrow('disque plein');
    expect(ligneRefus(r)).toMatch(/non joué : erreur : disque plein/);
    expect(await complet([], ioTest({ BENCH_ROOT: r, HOME: r }), faux().d)).toBe(0);
    expect(existsSync(join(r, FICHIER_REFUS))).toBe(false);
  });
  it('sans séquence : refus noté aussi', async () => {
    const r = racine();
    expect(await complet([], ioTest({ BENCH_ROOT: r, HOME: r }), faux().d)).toBe(2);
    expect(ligneRefus(r)).toMatch(/aucune séquence sous/);
  });
});

describe('L804 : construction et relance réelles, contrôles du service', () => {
  const v2 = (build: string) => {
    const repo = dossierTemp('l804-npm-'); mkdirSync(join(repo, 'v2', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'v2', 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { build } }));
    return repo;
  };
  it('construireV2 lance npm run build dans v2 : null si vert, la fin de la sortie sinon', () => {
    const ok = v2('node -e "require(\'fs\').writeFileSync(\'construit\', \'1\')"');
    expect(construireV2(ok)).toBeNull();
    expect(existsSync(join(ok, 'v2', 'construit'))).toBe(true);
    expect(construireV2(v2('node -e "console.error(\'error TS2304: Cannot find name\'); process.exit(2)"'))).toMatch(/error TS2304: Cannot find name/);
  });
  it('relancerV2 lance v2/bin/cadence2.js avec les arguments et l\'environnement, et rend son code', async () => {
    const repo = v2('true'), trace = join(repo, 'trace.json');
    writeFileSync(join(repo, 'v2', 'bin', 'cadence2.js'), `require('fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ a: process.argv.slice(2), e: process.env.${ENV_CONSTRUIT} })); process.exit(3);`);
    expect(await relancerV2(repo, ['bench', 'complet'], { ...process.env, [ENV_CONSTRUIT]: '1' })).toBe(3);
    expect(JSON.parse(readFileSync(trace, 'utf8'))).toEqual({ a: ['bench', 'complet'], e: '1' });
  });
  it('le contrôle « node introuvable » du service écrit sa cause là où statut la lit', () => {
    const unite = readFileSync(join(import.meta.dirname, '..', 'systeme', 'cadence-banc.service'), 'utf8');
    const ligne = unite.split('\n').find((l) => l.startsWith('ExecStartPre=/bin/bash') && l.includes('node introuvable'))!;
    const script = ligne.replace(/^ExecStartPre=\/bin\/bash -c '/, '').replace(/'$/, '').replaceAll('$$', '$');
    const home = dossierTemp('l804-home-'), bin = join(home, 'bin'); mkdirSync(join(home, 'bench-cadence')); mkdirSync(bin);
    symlinkSync('/bin/date', join(bin, 'date')); // un PATH sans node
    expect(() => execFileSync('/bin/bash', ['-c', script], { env: { HOME: home, PATH: bin }, stdio: 'ignore' })).toThrow();
    expect(ligneRefus(join(home, 'bench-cadence'))).toMatch(/non joué : minuteur : node introuvable sur le PATH/);
  });
});
