// L792 (issue #68) : le brief rendu de cadence run nomme les commandes de vérification du projet quand la demande ou le dépôt a des fiches d'écran,
// et la session peut lancer `cadence spec check` (seule commande cadence permise). Testé sur le texte du brief rendu et les arguments de claude.
// Revue r1 : M1, le hook seul-spec-check.mjs refuse tout cadence ou raf hors spec check|qa (`cadence spec <lot> on|off` écrit le plan) ; m1, le lot du plan
// à spec (spec: true, screen: page) suffit ; m2, chaque branche de la détection par la demande.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli.js';
import { executerRun, repondreRun } from '../src/run/run.js';
import { HOOKS } from '../src/socle.js';
import { demandeToucheFiches, OUTILS_CADENCE } from '../../scripts/commandes-du-brief.mjs';
import { commite, depot, fauxClaude, git } from './run-outils.js';

type Appel = { args: string[]; env: NodeJS.ProcessEnv };
const prompt = (a: Appel) => a.args[a.args.indexOf('-p') + 1];
const interdits = (a: Appel) => a.args[a.args.indexOf('--disallowedTools') + 1].split(',');
function avec(repo: string, fichiers: Record<string, string>): string {
  for (const [f, t] of Object.entries(fichiers)) { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), t); }
  git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fiches');
  return repo;
}
const reglages = (a: string[]) => JSON.parse(readFileSync(a[a.indexOf('--settings') + 1], 'utf8')) as { hooks?: { PreToolUse?: unknown[] } };
const HOOK = join(HOOKS, 'seul-spec-check.mjs');
/** Le code de sortie et l'erreur du hook pour une commande Bash, comme Claude Code l'appelle (entrée JSON sur stdin). */
function hook(command: string, cwd?: string): { code: number | null; err: string } {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, ...(cwd ? { cwd } : {}) }), encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}
const YAML = 'orchestrate:\n  build: test -d docs\n  test: test -f fait.txt\n  accept: npx vitest run -c vitest.acceptation.config.ts\n';

describe('L792 : vérifications nommées dans le brief de cadence run', () => {
  it('un dossier de fiches : spec check, build, test et accept nommés ; « ni raf ni cadence » garde l exception ; cadence spec check permise', () => {
    const repo = avec(depot(), { 'cadence.yaml': YAML, 'docs/specs/accueil/fiche.yaml': 'ecran: {}\n', 'docs/specs/compte/fiche.yaml': 'ecran: {}\n' });
    const appels: Appel[] = [];
    let hooks = '';
    const fait = commite('fait.txt');
    const e = executerRun({ repo, demande: 'Corrige le libellé du bouton', lot: 'L9', exec: fauxClaude([(c, a) => { hooks = JSON.stringify(reglages(a).hooks); fait(c); }], appels), out: () => {} });
    expect(e).toMatchObject({ etat: 'integre', spec_check: true });
    const p = prompt(appels[0]);
    expect(p).toMatch(/Vérifications du projet \(lues dans cadence\.yaml\)/);
    expect(p).toContain('`docs/specs/<écran>/fiche.yaml`, 2 dans le dépôt) : `cadence spec check <fiche.yaml>`');
    expect(p).toContain('for f in docs/specs/*/fiche.yaml; do cadence spec check "$f"; done');
    expect(p).toContain('- Build (orchestrate.build) : `test -d docs`.');
    expect(p).toContain('- Tests (orchestrate.test) : `test -f fait.txt`.');
    expect(p).toContain('- Tests d\'acceptation (orchestrate.accept) : `npx vitest run -c vitest.acceptation.config.ts`');
    expect(p).toContain("N'utilise ni `raf` ni `cadence` (seule exception : `cadence spec check`, nommée dans les vérifications plus haut)");
    expect(p.indexOf('Lot du plan : L9')).toBeLessThan(p.indexOf('Vérifications du projet'));
    expect(p.indexOf('Vérifications du projet')).toBeLessThan(p.indexOf('\n---\n'));
    const d = interdits(appels[0]);
    expect(d).not.toContain('Bash(cadence:*)');
    expect(d).toEqual(expect.arrayContaining(['Bash(raf:*)', 'Bash(cadence run:*)', 'Bash(cadence orchestrate:*)', 'Bash(cadence deliver:*)', 'Bash(cadence spec reseal:*)', 'Bash(cadence spec green:*)']));
    // aucun motif ne sait dire « spec sauf check|qa » (un deny `cadence spec:*` l'emporterait) : le reste de spec est refusé par le hook
    expect(d.filter((x) => /cadence spec( check)?:/.test(x))).toEqual([]);
    expect(hooks).toContain('seul-spec-check.mjs');
    expect(hooks).toContain('premier-plan.mjs'); // le hook du socle est gardé
  });

  it('la demande parle de fiches d écran sans dossier : spec check nommée (aucune encore), dossier de orchestrate.spec.dir ; brief complet aussi', () => {
    const repo = avec(depot(), { 'cadence.yaml': 'orchestrate:\n  test: test -f fait.txt\n  spec:\n    dir: specs/ecrans/\n' });
    const appels: Appel[] = [];
    executerRun({ repo, demande: 'Amène les fiches d\'écran à « fiche valide »', pieces: ['cadence.yaml'], exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    const p = prompt(appels[0]);
    expect(p).toContain('`specs/ecrans/<écran>/fiche.yaml`, aucune encore) : `cadence spec check <fiche.yaml>`');
    expect(p).not.toMatch(/orchestrate\.build|orchestrate\.accept/); // non déclarées : non nommées
    expect(p).toContain("N'utilise ni `raf` ni `cadence` (seule exception : `cadence spec check`"); // brief v2d (mode complet)
    expect(p).toMatch(/Tu es le responsable de cette demande/);
  });

  it('ni fiche ni demande qui en parle : brief inchangé, cadence entièrement interdite', () => {
    const appels: Appel[] = [];
    const e = executerRun({ repo: depot(), demande: 'Crée fait.txt', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    expect(e.spec_check).toBeUndefined();
    expect(prompt(appels[0])).not.toMatch(/Vérifications du projet|spec check/);
    expect(prompt(appels[0])).toContain("N'utilise ni `raf` ni `cadence`. Ignore");
    expect(interdits(appels[0])).toContain('Bash(cadence:*)');
  });

  it('M1 (revue r1) : le hook refuse cadence spec <lot> on|off et tout autre cadence ou raf, laisse passer spec check|qa et le reste', () => {
    for (const c of ['cadence spec L9 on', 'cadence spec L9 off', 'cadence spec green L9', 'cadence spec reseal L9 t.test.ts', 'cadence spec', 'npx cadence spec L1 on',
      'npx -y cadence spec L1 on', 'node bin/cadence.js spec L1 on', './node_modules/.bin/cadence spec L1 off', 'pnpm exec cadence spec L1 on', 'FOO=1 cadence spec L1 on',
      'cadence spec check docs/specs/a/fiche.yaml && cadence spec L1 on', 'ls; cadence spec L1 on', 'echo $(cadence spec L1 on)', '(cd x && cadence spec L1 on)',
      'cadence run --liste', 'cadence orchestrate --status', 'raf start L1', 'raf spec L1 on', 'cadence raf done L1', 'cadence --version']) {
      const r = hook(c);
      expect(r.code, c).toBe(2);
      expect(r.err).toContain('la seule commande cadence permise est `cadence spec check|qa <fiche.yaml>`');
    }
    for (const c of ['cadence spec check docs/specs/a/fiche.yaml', 'cadence spec qa docs/specs/a/fiche.yaml > /tmp/qa.md', 'npx cadence spec check a/fiche.yaml',
      'for f in docs/specs/*/fiche.yaml; do cadence spec check "$f"; done', 'node bin/cadence.js spec check a/fiche.yaml', 'npx vitest run',
      'git commit -m "fix: cadence spec L1 on refusé"', "grep -n 'cadence spec green' docs/x.md", 'echo raf', 'ls cadence']) expect(hook(c).code, c).toBe(0);
  });

  it('m1 (revue r2) : node …/dist/cli.js de cadence (ou de son v2) est refusé, celui d un autre projet passe', () => {
    const racine = join(import.meta.dirname, '..', '..'), autre = avec(depot(), { 'package.json': '{ "name": "autre" }\n' });
    for (const [c, cwd] of [['node dist/cli.js spec L1 on', racine], ['node ./dist/cli.js spec L1 on', racine], ['node v2/dist/cli.js run --liste', racine],
      ['node ../dist/cli.js spec L1 on', join(racine, 'v2')], [`node ${join(racine, 'dist', 'cli.js')} start L1`, autre],
      ['node node_modules/@sylad/cadence/dist/cli.js spec L9 on', autre], ['cd x && node dist/cli.js spec L1 on', racine]] as const) {
      expect(hook(c, cwd).code, c).toBe(2);
    }
    for (const c of ['node dist/cli.js spec L1 on', 'node dist/cli.js', 'node src/cli.js spec L1 on']) expect(hook(c, autre).code, c).toBe(0);
  });

  it('m1 (revue r2) : node bin/raf.js, raf.js par chemin et raf.mjs sont refusés', () => {
    for (const c of ['node bin/raf.js start L1', 'node ./node_modules/@sylad/cadence/bin/raf.js done L1', '/x/bin/raf.js add "t"', 'node bin/raf.mjs list']) {
      expect(hook(c).code, c).toBe(2);
    }
  });

  it('m1 (revue r2) : /usr/bin/env cadence et env avec options sont refusés, env cadence spec check passe', () => {
    for (const c of ['/usr/bin/env cadence spec L1 on', 'env cadence spec L1 on', 'env -i cadence spec L1 on', 'env -u HOME cadence spec L1 on',
      '/usr/bin/env -C /tmp raf start L1', 'env FOO=1 raf start L1', '/usr/bin/nohup cadence run --liste']) expect(hook(c).code, c).toBe(2);
    for (const c of ['/usr/bin/env cadence spec check a/fiche.yaml', 'env -u HOME node x.js', '/usr/bin/env python3 x.py']) expect(hook(c).code, c).toBe(0);
  });

  it('m1 (revue r2) : npx cadence@<version> et @sylad/cadence@<version> sont refusés, leur spec check passe', () => {
    for (const c of ['npx cadence@latest spec L1 on', 'npx --yes cadence@latest spec L1 on', 'npx cadence@2.0.12 spec L1 off', 'npx -y @sylad/cadence@2.0.12 spec L1 on',
      'pnpm dlx @sylad/cadence@latest raf done L1', 'npx raf@1 start L1']) expect(hook(c).code, c).toBe(2);
    for (const c of ['npx cadence@latest spec check a/fiche.yaml', 'npx -y @sylad/cadence@2.0.12 spec qa a/fiche.yaml', 'npx vitest@3 run']) {
      expect(hook(c).code, c).toBe(0);
    }
  });

  it('m1 (revue r2) : sudo -u x cadence et ses options à valeur sont refusés', () => {
    for (const c of ['sudo -u x cadence spec L1 on', 'sudo -u x -g y raf start L1', 'sudo --user x cadence spec L1 on', 'sudo --user=x cadence spec L1 on',
      'sudo -E -u x /usr/local/bin/cadence spec L1 on', '/usr/bin/sudo -n cadence run --liste']) expect(hook(c).code, c).toBe(2);
    for (const c of ['sudo -u x cadence spec check a/fiche.yaml', 'sudo -u cadence ls', 'sudo -u raf whoami']) expect(hook(c).code, c).toBe(0);
  });

  it('m2 (revue r2) : le texte d un heredoc n est pas une commande ; ce qui suit sa ligne de fin est lu', () => {
    const corps = 'fix(L1): x\n\ncadence spec L1 on\n- raf add "x"\nraf start L1\n';
    for (const c of [`git commit -F - <<'EOF'\n${corps}EOF`, `git commit -F - <<EOF\n${corps}EOF\n`, `git commit -F - <<"EOF"\n${corps}EOF`,
      `cat > notes.md <<'FIN'\n- raf add "x"\ncadence run --liste\nFIN`, `cat <<-EOF > n.md\n\tcadence spec L1 on\n\tEOF`, `cat <<\\EOF\nraf start L1\nEOF`,
      `cat <<A <<B\ncadence run\nA\nraf start\nB\necho fini`, `cat <<EOF | tee x\nraf done L1\nEOF`, 'cat <<< "raf start L1"',
      `cat <<EOF\nEOFX\nraf start L1`]) expect(hook(c).code, c).toBe(0); // le dernier : heredoc jamais fermé, tout le reste est son texte
    for (const c of [`cat <<'EOF' > x\ncadence spec L1 on\nEOF\ncadence spec L1 on`, `cat <<EOF && raf start L1\ntexte\nEOF`,
      `git commit -F - <<'EOF'\nraf\nEOF\nraf start L1`, `cat <<-EOF\n\tx\n\tEOF\nraf start L1`, 'cat <<<"x"; raf start L1']) expect(hook(c).code, c).toBe(2);
  });

  it('M1 (revue r1) : la commande refusée par le hook écrirait bien le plan', async () => {
    const repo = avec(depot(), { '.cadence/raf.yaml': 'version: 1\nproject: x\nprefix: L\nlots:\n  - id: L1\n    title: Essai\n    status: todo\n' });
    expect(await run(['spec', 'L1', 'on'], { cwd: repo, env: { RAF_TODAY: '2026-11-20' }, out: () => {}, err: () => {}, now: () => new Date('2026-11-20T09:00:00') })).toBe(0);
    expect(readFileSync(join(repo, '.cadence', 'raf.yaml'), 'utf8')).toMatch(/spec: true/); // sans le hook, la session aurait touché au plan
    expect(hook('cadence spec L1 on').code).toBe(2);
  });

  it('sans fiche : pas de hook seul-spec-check (cadence reste interdite en entier)', () => {
    let hooks = '';
    const fait = commite('fait.txt');
    executerRun({ repo: depot(), demande: 'Crée fait.txt', exec: fauxClaude([(c, a) => { hooks = JSON.stringify(reglages(a).hooks); fait(c); }], []), out: () => {} });
    expect(hooks).not.toContain('seul-spec-check.mjs');
    expect(hooks).toContain('premier-plan.mjs');
  });

  it('m1 (revue r1) : un lot du plan à spec (spec: true ou screen: page) nomme spec check sans fiche ni mot de la demande', () => {
    const plan = 'version: 1\nproject: x\nprefix: L\nlots:\n  - id: L1\n    title: a\n    status: todo\n    spec: true\n  - id: L2\n    title: b\n    status: todo\n'
      + '    screen: page\n  - id: L3\n    title: c\n    status: todo\n    tasks:\n      - { id: L3/1, title: d, status: todo, spec: true }\n  - id: L4\n    title: e\n    status: todo\n';
    for (const [i, [lot, nomme]] of ([['L1', true], ['L2', true], ['L3/1', true], ['L4', false], ['L9', false]] as const).entries()) {
      const repo = avec(depot(), { '.cadence/raf.yaml': plan }), appels: Appel[] = [];
      const e = executerRun({ id: `20261120090000-${100 + i}`, repo, demande: 'Écris la spec de l\'écran Compte', lot, exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
      expect(e.spec_check === true, lot).toBe(nomme);
      expect(prompt(appels[0]).includes('`cadence spec check <fiche.yaml>`'), lot).toBe(nomme);
    }
  });

  it('m2 (revue r1) : chaque branche de la détection par la demande, accents et apostrophe typographique compris', () => {
    for (const d of ['Amène les fiches d\'écran à « fiche valide »', 'Corrige la fiche d’écran Compte', 'Écris les fiches back du module', 'Une fiche back',
      'Les fiches mixtes', 'la fiche mixte', 'Rends les fiches valides', 'une fiche valide', 'Modifie docs/specs/compte/fiche.yaml', 'Lance spec check partout',
      'FICHES D\'ÉCRANS']) expect(demandeToucheFiches(d), d).toBe(true);
    for (const d of ['Crée fait.txt', 'Corrige la fiche de paie', 'Les fiches du lot', 'spec du lot']) expect(demandeToucheFiches(d), d).toBe(false);
  });

  it('reprise par --reponse : la session garde cadence spec check permise', () => {
    const repo = avec(depot(), { 'docs/specs/accueil/fiche.yaml': 'ecran: {}\n' });
    const appels: Appel[] = [];
    const exec = fauxClaude([(cwd) => writeFileSync(`${cwd}.question.md`, 'Laquelle ?'), commite('fait.txt')], appels);
    const e1 = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e1.etat).toBe('attente');
    expect(repondreRun(e1.id, repo, 'la première', { exec, out: () => {} }).etat).toBe('integre');
    expect(interdits(appels[1])).not.toContain('Bash(cadence:*)');
    expect(interdits(appels[1])).toContain('Bash(cadence run:*)');
  });

  it('chaque outil de bin/cadence.js sauf spec reste interdit (une commande ajoutée au bin sans ici échoue)', () => {
    const bin = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'cadence.js'), 'utf8');
    const outils = [...bin.matchAll(/tool === '([a-z][a-z-]*)'/g)].map((m) => m[1]);
    const liste = /\[((?:'[a-z-]+',?\s*)+)\]\.includes\(tool\)/.exec(bin)?.[1].match(/[a-z-]+/g) ?? [];
    expect(liste.length).toBeGreaterThan(10);
    for (const o of [...outils, ...liste].filter((x) => x !== 'spec')) expect(OUTILS_CADENCE).toContain(o);
  });
});
