import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { tempDir } from './helpers.js';
import { checkLinks, CHECKED } from '../scripts/check-links.mjs';
import { readOrchestrateConfig, readPlanConfig } from '../src/config.js';
import { planCommitProblem } from '../src/plan-commit.js';

// L363 — « cadence avec vos outils » : pour une équipe déjà outillée (tracker, HANDOFF.md, ADR, convention de commits).
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const readme = read('README.md');
const page = read('docs/with-your-tools.md');
const files: string[] = JSON.parse(read('package.json')).files;

/** Corps d'une section `## titre` de la page (jusqu'à la section suivante). */
const section = (titre: string): string => {
  const debut = page.indexOf(`\n## ${titre}`);
  expect(debut, `section « ${titre} » absente`).toBeGreaterThan(-1);
  const fin = page.indexOf('\n## ', debut + 5);
  return page.slice(debut, fin === -1 ? undefined : fin);
};
const blocs = (texte: string, langue: string): string[] => [...texte.matchAll(new RegExp('```' + langue + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]);

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contraste = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('cadence avec vos outils (L363)', () => {
  it('R1 — le README a une section courte « With the tools you already have » qui renvoie à docs/with-your-tools.md, sans détail', () => {
    const debut = readme.indexOf('\n## With the tools you already have');
    expect(debut).toBeGreaterThan(-1);
    const corps = readme.slice(debut, readme.indexOf('\n## ', debut + 5));
    expect(corps).toMatch(/\[docs\/with-your-tools\.md\]\(docs\/with-your-tools\.md\)/);
    expect(corps.split('\n').length).toBeLessThanOrEqual(12);
    for (const mot of ['Linear', 'HANDOFF.md', 'ADR']) expect(corps, mot).toContain(mot);
  });

  it('R2 — la page suit les quatre questions d\'une équipe outillée, dans l\'ordre : ne remplace pas, optionnel, se branche, apporte en plus', () => {
    const ordre = ['What cadence does not replace', 'What is optional', 'What plugs into what you have', 'What it adds'];
    let pos = -1;
    for (const t of ordre) {
      const i = page.indexOf(`\n## ${t}`);
      expect(i, `« ${t} » absent ou hors d'ordre`).toBeGreaterThan(pos);
      pos = i;
    }
  });

  it('R3 — « ne remplace pas » nomme le tracker, HANDOFF.md, les ADR et la convention de commits, chacun avec ce que cadence en garde', () => {
    const s = section('What cadence does not replace');
    for (const mot of ['Linear', 'HANDOFF.md', 'ADR', 'Conventional Commits']) expect(s, mot).toContain(mot);
    expect(s).toMatch(/board|assign/i);
  });

  it('R4 — « optionnel » dit que raf, session start/close et le hook se prennent un à un, et que la vague et deliver demandent seulement un plan lisible', () => {
    const s = section('What is optional');
    for (const mot of ['raf', 'cadence session start', 'cadence session close', 'raf hook install', 'cadence orchestrate', 'cadence deliver']) expect(s, mot).toContain(mot);
    expect(s).toMatch(/read-only/);
  });

  it('R5 — « se branche » : le plan d\'un autre outil en lecture seule (plan: dans cadence.yaml), plan.commit réglable (ticket #15), docs.sync pour les docs existantes', () => {
    const s = section('What plugs into what you have');
    for (const mot of ['plan:', 'plan.commit', '#15', 'docs.sync', 'commit-msg']) expect(s, mot).toContain(mot);
    expect(s).toContain('raf.md#the-subject-of-the-plan-commits-plancommit-l343');
  });

  it('R6 — les blocs YAML de cette section sont de la configuration valide, lue par le vrai lecteur de cadence', () => {
    const yaml = blocs(section('What plugs into what you have'), 'yaml');
    expect(yaml.length).toBeGreaterThanOrEqual(2);
    const d = tempDir();
    for (const b of yaml) {
      const f = join(d, 'cadence.yaml');
      writeFileSync(f, b);
      const doc = parse(b);
      if (doc.plan) {
        const plan = readPlanConfig(f, d);
        expect(plan, b).not.toBeNull();
        if (doc.plan.commit) expect(planCommitProblem(doc.plan.commit), b).toBeNull();
      }
      if (doc.orchestrate) expect(() => readOrchestrateConfig(f), b).not.toThrow();
    }
    expect(yaml.some((b) => parse(b).plan?.commit)).toBe(true);
    expect(yaml.some((b) => parse(b).docs?.sync)).toBe(true);
  });

  it('R7 — « apporte en plus » dit les vagues avec revue automatique et deliver qui vérifie l\'effet, avec renvoi vers leurs pages', () => {
    const s = section('What it adds');
    expect(s).toMatch(/review/i);
    expect(s).toMatch(/effect/i);
    expect(s).toContain('orchestrate.md');
    expect(s).toContain('deliver.md');
  });

  it('R8 — le schéma est une paire claire/sombre, publiée dans le paquet, qui nomme vos outils, ce qui se branche et ce que cadence ajoute', () => {
    for (const v of ['light', 'dark']) {
      const f = `docs/with-your-tools-${v}.svg`;
      expect(page).toContain(f.replace('docs/', ''));
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(files, f).toContain(f);
      const svg = read(f);
      for (const mot of ['Linear', 'HANDOFF.md', 'ADR', 'commits', 'plan', 'wave', 'deliver']) expect(svg.toLowerCase(), mot).toContain(mot.toLowerCase());
    }
    expect(files).toContain('docs/with-your-tools.md');
  });

  it.each(['light', 'dark'])('R8 — chaque texte du schéma %s a un contraste d\'au moins 4,5:1 avec le fond général ou son cadre', (v) => {
    const svg = read(`docs/with-your-tools-${v}.svg`);
    const fond = svg.match(/<rect width="\d+" height="\d+" fill="(#[0-9a-f]{6})"/)![1];
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], fill: m[5] }));
    const textes = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*fill="(#[0-9a-f]{6})"[^>]*>([^<]*)</g)];
    expect(textes.length).toBeGreaterThan(10);
    const sous = textes.filter((m) => {
      const dessous = rects.filter((r) => +m[1] >= r.x && +m[1] <= r.x + r.w && +m[2] >= r.y && +m[2] <= r.y + r.h).pop();
      return contraste(m[3], dessous?.fill ?? fond) < 4.5;
    }).map((m) => m[4]);
    expect(sous).toEqual([]);
  });

  it('R9 — la page est contrôlée par le contrôle des liens, citée par la carte de docs/overview.md, et ses liens tiennent', () => {
    expect(CHECKED).toContain('docs/with-your-tools.md');
    const carte = read('docs/overview.md').split('## Where to read more')[1]?.split(/\n## /)[0] ?? '';
    expect(carte).toMatch(/\[docs\/with-your-tools\.md\]\(with-your-tools\.md\)/);
    expect(checkLinks(root)).toEqual([]);
  });

  it('R9b — (L375) la page dit que, par défaut, les commits de plan lisent encore « plan: » et qu\'il faut poser plan.commit', () => {
    const para = page.split('\n').find((l) => l.startsWith('**The subject of the plan commits.**')) ?? '';
    expect(para).not.toMatch(/used to read/);
    expect(para).toMatch(/by default they still read `plan: L12 démarré \(orchestrate …\)`/i);
    expect(para).toMatch(/set `plan\.commit`/i);
  });

  it('R10 — le CHANGELOG annonce la page sous [Unreleased]', () => {
    const non = read('CHANGELOG.md').split(/\n(?=## \[)/).find((s) => s.startsWith('## [Unreleased]')) ?? '';
    expect(non).toMatch(/L363[^\n]*with-your-tools|with-your-tools[^\n]*L363/);
  });

  it('R11 — parcours réel : le plan de tracker de la page, rejoué tel qu\'écrit dans un dépôt neuf, est lu (raf list, raf check), les commits à vos ids sont comptés et raf add refuse', () => {
    const s = section('What plugs into what you have');
    const tickets = blocs(s, 'yaml').find((b) => b.startsWith('# tracker/tickets.yaml'));
    const config = blocs(s, 'yaml').find((b) => b.startsWith('# cadence.yaml') && b.includes('fields:'));
    expect(tickets, 'bloc tracker/tickets.yaml absent').toBeDefined();
    expect(config, 'bloc cadence.yaml avec fields: absent').toBeDefined();
    const d = tempDir();
    const bin = join(d, 'bin');
    mkdirSync(bin);
    const raf = join(d, 'raf-sources.ts');
    writeFileSync(raf, `import { run } from '${join(root, 'src/cli.ts')}';\nprocess.exitCode = await run(process.argv.slice(2), { cwd: process.cwd(), env: process.env, out: (l) => console.log(l), err: (l) => console.error(l), now: () => new Date() });\n`);
    writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec ${join(root, 'node_modules/.bin/vite-node')} ${raf} -- "$@"\n`);
    chmodSync(join(bin, 'raf'), 0o755);
    const projet = join(d, 'projet');
    mkdirSync(join(projet, 'tracker'), { recursive: true });
    writeFileSync(join(projet, 'tracker/tickets.yaml'), tickets!);
    writeFileSync(join(projet, 'cadence.yaml'), config!);
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false',
    };
    const sh = (cmd: string) => execFileSync('bash', ['-e', '-c', cmd], { cwd: projet, env, encoding: 'utf8', stdio: 'pipe' });
    sh('git init -q -b main && git add -A && git commit -qm "chore: init" && git commit -q --allow-empty -m "feat(ENG-12): export csv"');
    expect(sh('raf list')).toMatch(/ENG-12\s+doing\s+Export CSV/);
    expect(sh('raf commits ENG-12')).toContain('feat(ENG-12): export csv');
    expect(sh('raf check')).toContain('cohérents');
    expect(() => sh('raf add "x"')).toThrow(/lecture seule/);
  });
});
