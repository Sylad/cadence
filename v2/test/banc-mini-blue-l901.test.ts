// L901 (D-39, D-40) : le banc tourne DÉTACHÉ sur mini-blue, depuis une copie figée de cadence, et ses rapports reviennent dans la racine
// de Big-Blue. Ici, le transport local (BANC_MB_TRANSPORT=local) remplace ssh et scp : même scripts, même dossier d'échange, sans réseau ;
// la commande de fumée remplace le banc (aucun modèle) et vérifie, depuis « là-bas », ce que le banc y trouverait.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { empreinte } from '../src/bench/cli.js';
import { dossierTemp } from './temp.js';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'banc-mini-blue.sh');
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
const depotGit = (d: string, fichiers: Record<string, string>) => {
  for (const [f, c] of Object.entries(fichiers)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), c); }
  git(d, 'init', '-q', '-b', 'main'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'base');
  return git(d, 'rev-parse', 'HEAD');
};

/** Ce que « mini-blue » vérifie avant d'écrire un faux passage : copie au bon commit, chemins de Big-Blue réécrits, source clonable à sa base. */
const FUMEE = `set -e
sleep 2
test "$(git rev-parse HEAD)" = "$SHA_ATTENDU"
test -f "$BENCH_ROOT/secrets/1-a/cache.test.ts"
src=$(sed -n 's/^source: //p' "$BENCH_ROOT/bancs/1-a/banc.yaml")
case $src in "$BIGBLUE"*) echo "source non réécrite : $src"; exit 7 ;; esac
git clone -q "$src" "$BENCH_ROOT/verif" && git -C "$BENCH_ROOT/verif" cat-file -e "$BASE_SOURCE"
grep -q "brief: $PWD/v2/briefs/b.md" "$BENCH_ROOT/bras.yaml"
mkdir -p "$BENCH_ROOT/rapports" "$BENCH_ROOT/runs/p1/1-a/c1/node_modules/x"
echo '# passage p1' > "$BENCH_ROOT/rapports/p1.md"; echo '{}' > "$BENCH_ROOT/rapports/p1.json"
echo '{"run":"p1","vert":true}' >> "$BENCH_ROOT/historique.jsonl"
echo '{"vert":true}' > "$BENCH_ROOT/runs/p1/1-a/resultat.json"; echo lourd > "$BENCH_ROOT/runs/p1/1-a/c1/node_modules/x/f"
echo "verdict : vert"`;

describe('banc détaché sur mini-blue (L901)', () => {
  it('lance rend la main aussitôt, le banc tourne sur la copie figée, attendre ramène rapports, runs et historique', () => {
    const t = dossierTemp('l901-');
    const BIGBLUE = join(t, 'bigblue');
    const depot = join(BIGBLUE, 'cadence'), source = join(BIGBLUE, 'projet'), racine = join(BIGBLUE, 'bench-cadence');
    const sha = depotGit(depot, { 'v2/src/a.ts': 'export {}\n', 'v2/briefs/b.md': 'brief\n', 'v2/hooks/h.mjs': '// hook\n' });
    const base = depotGit(source, { 'index.js': '1\n' });
    git(source, 'commit', '-q', '--allow-empty', '-m', 'après la base'); // la source a avancé : la base doit rester joignable là-bas
    for (const [f, c] of Object.entries({
      'bras.yaml': `A:\n  modele: opus\n  brief: ${depot}/v2/briefs/b.md\n`,
      'bancs/1-a/banc.yaml': `projet: p\nsource: "${source}"\nbase: ${base}\ninstall: "true"\ntests: "true"\ntaille: retouche\n`,
      'secrets/1-a/cache.test.ts': 'caché\n',
      'historique.jsonl': '{"run":"a"}\n{"run":"b"}\n',
      'rapports/ancien.json': '{}\n', 'rapports/ancien.md': '# ancien\n',
    })) { mkdirSync(join(racine, f, '..'), { recursive: true }); writeFileSync(join(racine, f), c); }
    const env = { ...process.env, BANC_MB_TRANSPORT: 'local', BANC_MB_ECHANGE: join(t, 'echange'), BANC_MB_JOBS: join(t, 'jobs'), BANC_MB_BASE: join(t, 'mini-blue'),
      BENCH_ROOT: racine, BANC_MB_PAS: '1', SHA_ATTENDU: sha, BIGBLUE, BASE_SOURCE: base };
    const sh = (...a: string[]) => spawnSync('bash', [SCRIPT, ...a], { env, encoding: 'utf8', timeout: 60_000 });

    const debut = Date.now();
    const l = sh('lance', '--depot', depot, '--sans-construction', '--commande', FUMEE, 'court');
    expect(l.stderr).toBe('');
    expect(l.status).toBe(0);
    expect(Date.now() - debut).toBeLessThan(15_000);
    expect(l.stdout).toContain(`empreinte ${empreinte(depot)}`); // même empreinte que le banc (cli.ts)
    expect(l.stdout).toContain('1 source(s)');
    expect(sh('etat').stdout).toMatch(/etat=en cours/);
    expect(sh('lance', '--depot', depot, '--sans-construction', '--commande', 'true', 'court').status).toBe(3); // un seul banc à la fois

    // le dépôt est libre : un commit pendant le banc ne change pas la copie mesurée (SHA_ATTENDU vérifié là-bas)
    writeFileSync(join(depot, 'v2', 'src', 'a.ts'), 'export const x = 1;\n'); git(depot, 'commit', '-qam', 'pendant le banc');

    const a = sh('attendre');
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('fini rc=0');
    expect(a.stdout).toContain(join(racine, 'rapports', 'p1.md'));
    expect(a.stdout).toContain('verdict : vert');
    expect(readFileSync(join(racine, 'rapports', 'p1.md'), 'utf8')).toBe('# passage p1\n');
    expect(readFileSync(join(racine, 'historique.jsonl'), 'utf8')).toBe('{"run":"a"}\n{"run":"b"}\n{"run":"p1","vert":true}\n');
    expect(existsSync(join(racine, 'runs', 'p1', '1-a', 'resultat.json'))).toBe(true);
    expect(existsSync(join(racine, 'runs', 'p1', '1-a', 'c1', 'node_modules'))).toBe(false); // le lourd reste là-bas
    expect(readdirSync(join(racine, 'rapports')).sort()).toEqual(['ancien.json', 'ancien.md', 'p1.json', 'p1.md']);

    // rien ne revient deux fois, et l'état se lit sans aller-retour
    expect(sh('recup').stdout).toContain('aucun banc fini à ramener');
    expect(readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
    expect(sh('etat').stdout).toMatch(/etat=fini rc=0 recupere=oui/);
  });

  it('un banc en échec là-bas revient avec son code, et le dossier d’échange ne garde que ce que le banc a reçu et rendu', () => {
    const t = dossierTemp('l901-echec-');
    const depot = join(t, 'cadence'), racine = join(t, 'bench-cadence');
    depotGit(depot, { 'v2/src/a.ts': '\n', 'v2/briefs/b.md': '\n' });
    mkdirSync(racine); writeFileSync(join(racine, 'bras.yaml'), 'A: {}\n');
    const env = { ...process.env, BANC_MB_TRANSPORT: 'local', BANC_MB_ECHANGE: join(t, 'echange'), BANC_MB_JOBS: join(t, 'jobs'), BANC_MB_BASE: join(t, 'mb'), BENCH_ROOT: racine, BANC_MB_PAS: '1' };
    const sh = (...a: string[]) => spawnSync('bash', [SCRIPT, ...a], { env, encoding: 'utf8', timeout: 60_000 });
    expect(sh('lance', '--depot', depot, '--sans-construction', '--commande', 'echo bench refusé >&2; exit 2', 'mecanique').status).toBe(0);
    const a = sh('attendre');
    expect(a.stdout).toContain('fini rc=2');
    expect(a.stdout).toContain('bench refusé');
    const [job] = readdirSync(join(t, 'echange'));
    expect(readdirSync(join(t, 'echange', job)).sort()).toEqual(['aller.bundle', 'args.sh', 'banc-mini-blue-distant.sh', 'debut', 'distant.log', 'fin.txt', 'referentiel.tar.gz', 'retour.tar.gz', 'run.log', 'sources']);
    expect(execFileSync('tar', ['-tzf', join(t, 'echange', job, 'referentiel.tar.gz')], { encoding: 'utf8' }).trim()).toBe('bras.yaml');
  });

  it('un banc arrêté avant de mesurer (construction de v2 impossible) revient avec son code et sa cause', () => {
    const t = dossierTemp('l901-build-');
    const depot = join(t, 'cadence'), racine = join(t, 'bench-cadence');
    depotGit(depot, { 'v2/src/a.ts': '\n', 'v2/briefs/b.md': '\n' }); // ni package.json ni lock : npm ci échoue là-bas
    mkdirSync(racine); writeFileSync(join(racine, 'bras.yaml'), 'A: {}\n');
    const env = { ...process.env, BANC_MB_TRANSPORT: 'local', BANC_MB_ECHANGE: join(t, 'echange'), BANC_MB_JOBS: join(t, 'jobs'), BANC_MB_BASE: join(t, 'mb'), BENCH_ROOT: racine, BANC_MB_PAS: '1' };
    const sh = (...a: string[]) => spawnSync('bash', [SCRIPT, ...a], { env, encoding: 'utf8', timeout: 60_000 });
    expect(sh('lance', '--depot', depot, 'court').status).toBe(0);
    const a = sh('attendre');
    expect(a.status).toBe(0);
    expect(a.stdout).toMatch(/fini rc=94 avant le banc, rien à ramener : npm ci racine/);
    expect(sh('etat').stdout).toMatch(/etat=fini rc=94 recupere=oui/);
  });

  it('refuse sans bras.yaml dans la racine du banc', () => {
    const t = dossierTemp('l901-refus-');
    const r = spawnSync('bash', [SCRIPT, 'lance', 'court'], { env: { ...process.env, BANC_MB_TRANSPORT: 'local', BANC_MB_ECHANGE: join(t, 'e'), BANC_MB_JOBS: join(t, 'j'), BENCH_ROOT: t }, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('bras.yaml absent');
  });
});
