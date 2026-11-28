// L901 (D-39, D-40) : le banc tourne DÉTACHÉ sur mini-blue, depuis une copie figée de cadence, et ses rapports reviennent dans la racine
// de Big-Blue. Ici, le transport local (BANC_MB_TRANSPORT=local) remplace ssh et scp : même scripts, même dossier d'échange, sans réseau ;
// la commande de fumée remplace le banc (aucun modèle) et vérifie, depuis « là-bas », ce que le banc y trouverait.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { empreinte } from '../src/bench/cli.js';
import { statut } from '../src/bench/verdict.js';
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
inst=$(sed -n 's/^install: //p' "$BENCH_ROOT/bancs/1-a/banc.yaml")
case $inst in *"$BIGBLUE"*) echo "install non réécrite : $inst"; exit 8 ;; esac
test "$(bash -c "$inst")" = 1   # L941 : git -C <miroir nu> show <base>:index.js
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
    // revue L901 : un « git stash -u » garde les fichiers non suivis (.env et ses clés) sous refs/stash ; rien de cela ne part sur mini-blue
    writeFileSync(join(source, '.env'), 'ANTHROPIC_API_KEY=sk-secret\n');
    git(source, 'stash', 'push', '-q', '-u', '-m', 'wip');
    const nonSuivis = git(source, 'rev-parse', 'refs/stash^3');
    for (const [f, c] of Object.entries({
      'bras.yaml': `A:\n  modele: opus\n  brief: ${depot}/v2/briefs/b.md\n`,
      'bancs/1-a/banc.yaml': `projet: p\nsource: "${source}"\nbase: ${base}\ninstall: git -C ${source} show ${base}:index.js\ntests: "true"\ntaille: retouche\n`,
      'secrets/1-a/cache.test.ts': 'caché\n',
      'historique.jsonl': '{"run":"a"}\n{"run":"b"}\n',
      'rapports/ancien.json': '{}\n', 'rapports/ancien.md': '# ancien\n',
    })) { mkdirSync(join(racine, f, '..'), { recursive: true }); writeFileSync(join(racine, f), c); }
    mkdirSync(join(t, 'echange')); // transport local : le dossier d'échange présent, c'est mini-blue joignable
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

    // le miroir de la source là-bas n'a ni refs/stash ni l'objet des fichiers non suivis ; le .env est resté sur Big-Blue
    const [miroir] = readdirSync(join(t, 'mini-blue', 'sources'));
    const m = join(t, 'mini-blue', 'sources', miroir);
    expect(git(m, 'for-each-ref', '--format=%(refname)')).not.toContain('refs/stash');
    expect(spawnSync('git', ['cat-file', '-e', nonSuivis], { cwd: m }).status).not.toBe(0);
    expect(spawnSync('git', ['cat-file', '-e', base], { cwd: m }).status).toBe(0);

    // rien ne revient deux fois, et l'état se lit sans aller-retour
    expect(sh('recup').stdout).toContain('aucun banc fini à ramener');
    expect(readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
    expect(sh('etat').stdout).toMatch(/etat=fini rc=0 recupere=oui/);
  });

  it('un banc en échec là-bas revient avec son code, et le dossier d’échange ne garde que ce que le banc a reçu et rendu', () => {
    const t = dossierTemp('l901-echec-');
    const depot = join(t, 'cadence'), racine = join(t, 'bench-cadence');
    depotGit(depot, { 'v2/src/a.ts': '\n', 'v2/briefs/b.md': '\n' });
    mkdirSync(racine); writeFileSync(join(racine, 'bras.yaml'), 'A: {}\n'); mkdirSync(join(t, 'echange'));
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
    mkdirSync(racine); writeFileSync(join(racine, 'bras.yaml'), 'A: {}\n'); mkdirSync(join(t, 'echange'));
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

  /** Racine et dépôt minimaux, et le lanceur du script en transport local. */
  const banc = (prefixe: string, extra: Record<string, string> = {}) => {
    const t = dossierTemp(prefixe);
    const depot = join(t, 'cadence'), racine = join(t, 'bench-cadence');
    depotGit(depot, { 'v2/src/a.ts': '\n', 'v2/briefs/b.md': '\n' });
    mkdirSync(racine); writeFileSync(join(racine, 'bras.yaml'), 'A: {}\n'); mkdirSync(join(t, 'echange'));
    const env = { ...process.env, BANC_MB_TRANSPORT: 'local', BANC_MB_ECHANGE: join(t, 'echange'), BANC_MB_JOBS: join(t, 'jobs'), BANC_MB_BASE: join(t, 'mb'), BENCH_ROOT: racine, BANC_MB_PAS: '1', ...extra };
    const sh = (...a: string[]) => spawnSync('bash', [SCRIPT, ...a], { env, encoding: 'utf8', timeout: 60_000 });
    return { t, depot, racine, sh };
  };

  it('les lignes rapatriées sont insérées à leur date : un mécanique vert de mini-blue ne passe pas après un éclair rouge local plus récent', () => {
    const { depot, racine, sh } = banc('l901-ordre-');
    const ligne = (date: string, x: Record<string, unknown>) => JSON.stringify({ date, empreinte: 'e1', candidat: 'cadence-run', reference: 'A', modele_candidat: 'opus', hebdo: false, frais: 0, ...x });
    const avant = ligne('2026-11-27T08:00:00.000Z', { niveau: 'mecanique', bancs: ['1-a', '3-b', '7-c'], vert: true, empreinte: 'e0' });
    const meca = ligne('2026-11-27T09:30:00.000Z', { niveau: 'mecanique', bancs: ['1-a', '3-b', '7-c'], vert: true });
    const eclair = ligne('2026-11-27T11:00:00.000Z', { bancs: ['1-a'], vert: false, eclair_ok: false });
    writeFileSync(join(racine, 'historique.jsonl'), `${avant}\n`);
    // « mini-blue » écrit son mécanique vert, puis attend que l'éclair rouge local soit écrit avant de finir
    const cmd = `echo '${meca}' >> "$BENCH_ROOT/historique.jsonl"; sleep 3`;
    expect(sh('lance', '--depot', depot, '--sans-construction', '--commande', cmd, 'mecanique').status).toBe(0);
    writeFileSync(join(racine, 'historique.jsonl'), `${avant}\n${eclair}\n`); // éclair local rouge, écrit pendant le banc
    const a = sh('attendre');
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("1 ligne(s) d'historique");
    const h = readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(h).toEqual([avant, meca, eclair]);
    // la garde lit cet ordre : le rouge suit le vert, la publication de l'empreinte reste refusée
    expect(statut(h, new Date('2026-11-27T12:00:00Z'), 'e1', { 'cadence-run': 'opus' }).publication_ok).toBe(false);
    // et sans l'éclair, le même mécanique l'aurait permise (le test mesure bien l'ordre)
    expect(statut([avant, meca], new Date('2026-11-27T12:00:00Z'), 'e1', { 'cadence-run': 'opus' }).publication_ok).toBe(true);
  });

  it('mini-blue injoignable : état inconnu, jamais fini — lance refuse (5), attendre réessaie puis échoue (6), rien n’est marqué ramené', () => {
    const { t, depot, sh } = banc('l901-injoignable-', { BANC_MB_ESSAIS: '2' });
    expect(sh('lance', '--depot', depot, '--sans-construction', '--commande', 'sleep 8; echo vert', 'court').status).toBe(0);
    const echange = join(t, 'echange'), cache = join(t, 'echange-coupe');
    const [job] = readdirSync(join(t, 'jobs'));
    // couper seulement une fois le banc lancé (run.log ouvert) : la copie et le référentiel lisent le dossier d'échange avant
    for (let k = 0; k < 100 && !existsSync(join(echange, job, 'run.log')); k++) spawnSync('sleep', ['0.1']);
    renameSync(echange, cache); // la coupure : plus rien ne répond là-bas
    try {
      const l = sh('lance', '--depot', depot, '--sans-construction', '--commande', 'true', 'court');
      expect(l.status).toBe(5);
      expect(l.stderr).toContain('injoignable');
      const a = sh('attendre');
      expect(a.status).toBe(6);
      expect(a.stderr).toContain('injoignable 2 fois de suite');
      expect(a.stdout).not.toContain('aucun banc fini');
      const r = sh('recup');
      expect(r.status).toBe(5);
      expect(r.stdout).not.toContain('aucun banc fini');
      expect(sh('etat').stdout).toMatch(/etat=injoignable recupere=non/);
    } finally { renameSync(cache, echange); }
    expect(existsSync(join(t, 'jobs', job, 'recupere'))).toBe(false);
    // revenu : attendre va au bout et ramène le banc
    const a = sh('attendre');
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('fini rc=0');
  });

  it('lance pendant que mini-blue est éteint : rien lancé (5), aucun job local laissé ; mini-blue revenu, le lance suivant passe', () => {
    const { t, depot, sh } = banc('l901-eteint-');
    const echange = join(t, 'echange'), coupe = join(t, 'echange-coupe');
    renameSync(echange, coupe); // éteint dès le départ : l'envoi échoue
    const l = sh('lance', '--depot', depot, '--sans-construction', '--commande', 'true', 'court');
    expect(l.status).toBe(5);
    expect(l.stderr).toContain('envoi');
    expect(existsSync(join(t, 'jobs')) ? readdirSync(join(t, 'jobs')) : []).toEqual([]);
    renameSync(coupe, echange); // revenu
    const l2 = sh('lance', '--depot', depot, '--sans-construction', '--commande', 'echo vert', 'court');
    expect(l2.stderr).toBe('');
    expect(l2.status).toBe(0);
    const a = sh('attendre');
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('fini rc=0');
  });

  it('un job local que mini-blue ne connaît pas n’est pas « injoignable » : écarté avec un message, lance, recup et attendre passent', () => {
    const { t, depot, sh } = banc('l901-orphelin-');
    // orphelin d'un envoi interrompu (ancienne version du script : job créé avant l'envoi), et job envoyé dont le dossier là-bas a été effacé
    mkdirSync(join(t, 'jobs', '20261127-100000-x-court'), { recursive: true });
    writeFileSync(join(t, 'jobs', '20261127-100000-x-court', 'args.sh'), 'COMMANDE=true\n');
    mkdirSync(join(t, 'jobs', '20261127-100100-y-court'), { recursive: true });
    writeFileSync(join(t, 'jobs', '20261127-100100-y-court', 'envoye'), '');
    expect(sh('etat').stdout).toMatch(/20261127-100000-x-court etat=absent de mini-blue/);
    const r = sh('recup');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('20261127-100000-x-court jamais arrivé sur mini-blue (envoi interrompu) : retiré');
    expect(r.stderr).toContain('20261127-100100-y-court absent de mini-blue');
    expect(r.stderr).not.toContain('injoignable');
    expect(existsSync(join(t, 'jobs', '20261127-100000-x-court'))).toBe(false);
    expect(sh('etat').stdout).toMatch(/20261127-100100-y-court etat=absent de mini-blue, ignoré/);
    // le même cas vu par lance (sans recup avant) : un nouvel orphelin n'empêche pas de lancer
    mkdirSync(join(t, 'jobs', '20261127-100200-z-court'), { recursive: true });
    const l = sh('lance', '--depot', depot, '--sans-construction', '--commande', 'echo vert', 'court');
    expect(l.status).toBe(0);
    expect(l.stderr).toContain('20261127-100200-z-court jamais arrivé');
    expect(sh('attendre').status).toBe(0);
  });

  it('l’hôte vient de MINI_BLUE_HOTE ou de ~/.config/cadence/mini-blue-hote, jamais d’une valeur du script', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/); // aucune adresse écrite en dur
    const t = dossierTemp('l901-hote-');
    const sans = spawnSync('bash', [SCRIPT, 'etat'], { env: { ...process.env, MINI_BLUE_HOTE: '', XDG_CONFIG_HOME: t, BANC_MB_JOBS: join(t, 'j') }, encoding: 'utf8' });
    expect(sans.status).toBe(2);
    expect(sans.stderr).toContain('MINI_BLUE_HOTE');
    mkdirSync(join(t, 'cadence')); writeFileSync(join(t, 'cadence', 'mini-blue-hote'), 'alice@machine\n');
    const hote = (env: Record<string, string>) => spawnSync('bash', ['-c', `${src.split('\nusage()')[0]}\necho "$HOTE $ECH_WSL"`], { env: { ...process.env, MINI_BLUE_HOTE: '', XDG_CONFIG_HOME: t, ...env }, encoding: 'utf8' }).stdout.trim();
    expect(hote({})).toBe('alice@machine /mnt/c/Users/alice/mini-blue-banc');
    expect(hote({ MINI_BLUE_HOTE: 'bob@hote' })).toBe('bob@hote /mnt/c/Users/bob/mini-blue-banc');
    const avec = spawnSync('bash', [SCRIPT, 'etat'], { env: { ...process.env, MINI_BLUE_HOTE: '', XDG_CONFIG_HOME: t, BANC_MB_JOBS: join(t, 'j') }, encoding: 'utf8' });
    expect(avec.status).toBe(0);
  });

  it('un banc complet arrêté là-bas avant de mesurer pose complet-refus.txt, au format de noterRefus', () => {
    const { depot, racine, sh } = banc('l901-complet-');
    expect(sh('lance', '--depot', depot, 'complet').status).toBe(0); // ni package.json ni lock : npm ci échoue là-bas (rc 94)
    expect(sh('attendre').stdout).toMatch(/fini rc=94 avant le banc/);
    const [date, cause] = readFileSync(join(racine, 'complet-refus.txt'), 'utf8').trim().split('\n');
    expect(Number.isNaN(Date.parse(date))).toBe(false);
    expect(cause).toMatch(/banc complet sur mini-blue .* arrêté avant de mesurer, rc=94 : npm ci racine/);
  });

  it('le dossier d’échange vu du WSL suit l’utilisateur de MINI_BLUE_HOTE, ou MINI_BLUE_ECHANGE_WSL', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/\/Users\/sylva\b/);
    const dossier = (env: Record<string, string>) => spawnSync('bash', ['-c', `${src.split('\nusage()')[0]}\necho "$ECH_WSL"`], { env: { ...process.env, ...env }, encoding: 'utf8' }).stdout.trim();
    expect(dossier({ MINI_BLUE_HOTE: 'bob@hote' })).toBe('/mnt/c/Users/bob/mini-blue-banc');
    expect(dossier({ MINI_BLUE_HOTE: 'bob@hote', MINI_BLUE_ECHANGE_WSL: '/mnt/d/echange' })).toBe('/mnt/d/echange');
  });
});
