import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSectionOf } from './changelog-section.js';
import { parse } from 'yaml';
import { tempDir } from './helpers.js';
import { checkLinks, CHECKED } from '../scripts/check-links.mjs';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const readme = read('README.md');
const page = read('docs/quickstart.md');
const files: string[] = JSON.parse(read('package.json')).files;

/** Blocs de code d'une page, dans l'ordre (le texte, sans les balises). */
const blocs = (texte: string): string[] => [...texte.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);

describe('démarrage « lead multi-projets » en 10 minutes (L358)', () => {
  it('R1 — le README ouvre le démarrage multi-projets par une section courte qui renvoie à docs/quickstart.md, sans détail', () => {
    const debut = readme.indexOf('\n## Lead several projects');
    expect(debut).toBeGreaterThan(-1);
    const section = readme.slice(debut, readme.indexOf('\n## ', debut + 5));
    expect(section).toContain('10 minutes');
    expect(section).toContain('docs/quickstart.md');
    expect(section.split('\n').length).toBeLessThanOrEqual(12);
    expect(readme).toMatch(/\[docs\/quickstart\.md\]\(docs\/quickstart\.md\)/);
  });

  it('R2 — la page suit l\'ordre du parcours : prérequis, installation, plugin, dossier parent, raf init, tour, /lead, première vague', () => {
    const ordre = ['## Before you start', '## Install', '## The parent folder', 'raf init', 'cadence lead tour', '/cadence:lead', 'cadence orchestrate alpha:L1 --wave first'];
    let pos = -1;
    for (const m of ordre) {
      const i = page.indexOf(m, pos + 1);
      expect(i, `« ${m} » absent ou hors d'ordre`).toBeGreaterThan(pos);
      pos = i;
    }
  });

  it('R3 — les prérequis que le parcours mesuré a fait buter sont dits : Node 22.18, préfixe npm utilisateur (EACCES), identité git, Claude Code connecté', () => {
    const prerequis = page.slice(page.indexOf('## Before you start'), page.indexOf('## Install'));
    expect(prerequis).toContain('22.18');
    expect(prerequis).toMatch(/nvm|NodeSource/);
    expect(prerequis).toContain('git config --global user.name');
    expect(prerequis).toContain('claude auth status');
    expect(page).toContain('npm config set prefix');
    expect(page).toContain('EACCES');
  });

  it('R4 — le cadence.yaml minimal (la porte de tests) est écrit dans la page, et le premier commit de raf init ne demande plus raf ignore (L377)', () => {
    expect(page).toMatch(/orchestrate:\n\s+test:/);
    expect(page).not.toContain('raf ignore');
    expect(page).toContain('.:L1');
  });

  it('R5 — le schéma est une paire claire/sombre existante, publiée dans le paquet, qui nomme le dossier parent, le lead, la vague et les projets', () => {
    for (const v of ['light', 'dark']) {
      const f = `docs/quickstart-${v}.svg`;
      expect(page).toContain(f.replace('docs/', ''));
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(files, f).toContain(f);
      const svg = read(f).toLowerCase();
      for (const mot of ['parent folder', 'lead', 'wave', 'alpha', 'beta']) expect(svg, mot).toContain(mot);
    }
    expect(files).toContain('docs/quickstart.md');
  });

  it('R6 — la page est contrôlée par le contrôle des liens et ses liens tiennent', () => {
    expect(CHECKED).toContain('docs/quickstart.md');
    expect(checkLinks(root)).toEqual([]);
  });

  it('R7 — les commandes du bloc « dans chaque projet » rejouées telles qu\'écrites dans un dépôt neuf laissent un plan cohérent (raf check vert)', () => {
    const bloc = blocs(page).find((b) => b.includes('raf init') && b.includes('cadence.yaml'));
    expect(bloc, 'bloc « raf init … cadence.yaml » absent').toBeDefined();
    const d = tempDir();
    const bin = join(d, 'bin');
    mkdirSync(bin);
    // raf lancé depuis les sources (vite-node), comme les autres tests : bin/raf.js importe dist/, absent d'un arbre sans build
    const raf = join(d, 'raf-sources.ts');
    writeFileSync(raf, `import { run } from '${join(root, 'src/cli.ts')}';\nprocess.exitCode = await run(process.argv.slice(2), { cwd: process.cwd(), env: process.env, out: (l) => console.log(l), err: (l) => console.error(l), now: () => new Date() });\n`);
    const viteNode = join(root, 'node_modules/.bin/vite-node');
    writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec ${viteNode} ${raf} -- "$@"\n`);
    chmodSync(join(bin, 'raf'), 0o755);
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false',
    };
    // le bloc crée le dossier du projet (« mkdir alpha && cd alpha ») : on l'exécute depuis le dossier parent
    execFileSync('bash', ['-e', '-c', bloc!], { cwd: d, env, encoding: 'utf8', stdio: 'pipe' });
    const projet = join(d, 'alpha');
    expect(execFileSync(join(bin, 'raf'), ['check'], { cwd: projet, env, encoding: 'utf8' })).toContain('cohérents');
    expect(execFileSync('git', ['status', '--short'], { cwd: projet, env, encoding: 'utf8' })).toBe('');
    expect(existsSync(join(projet, 'cadence.yaml'))).toBe(true);
  });

  it('R8 — deux modèles de ticket GitHub (bug, demande) en formulaires valides, avec les champs qui évitent l\'aller-retour, et pas de ticket vide', () => {
    for (const [f, champs] of [['bug.yml', ['version', 'steps', 'expected', 'actual']], ['feature.yml', ['problem', 'proposal']]] as const) {
      const y = parse(read(`.github/ISSUE_TEMPLATE/${f}`));
      expect(y.name, f).toBeTruthy();
      expect(y.description, f).toBeTruthy();
      const ids = y.body.filter((b: { id?: string }) => b.id).map((b: { id: string }) => b.id);
      for (const c of champs) expect(ids, `${f} : ${c}`).toContain(c);
      const requis = y.body.filter((b: { validations?: { required?: boolean } }) => b.validations?.required);
      expect(requis.length, f).toBeGreaterThanOrEqual(2);
    }
    const bug = parse(read('.github/ISSUE_TEMPLATE/bug.yml'));
    expect(JSON.stringify(bug.body)).toMatch(/cadence --version/);
    const config = parse(read('.github/ISSUE_TEMPLATE/config.yml'));
    expect(config.blank_issues_enabled).toBe(false);
    expect(JSON.stringify(config.contact_links)).toContain('docs/quickstart.md');
  });

  it('R9 — le CHANGELOG annonce le démarrage et les modèles de tickets', () => {
    const section = changelogSectionOf(read('CHANGELOG.md'), '(L358');
    expect(section).toMatch(/L358[^\n]*quickstart/);
    expect(section).toMatch(/L358[^\n]*issue/i);
  });
});
