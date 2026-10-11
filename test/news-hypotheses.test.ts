import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { run } from '../src/cli.js';
import { parseEntry, newsIssues } from '../src/news.js';
import { ficheHypotheses } from '../src/spec.js';
import type { Lot } from '../src/plan.js';
import { gitRepo } from './helpers.js';
import { EXEMPLE } from './spec-helpers.js';

// L174 (spec etape-spec, S6) : la section « Hypothèses » de l'entrée Nouveautés d'un lot avec fiche, contrôlée par `cadence news check`.
const lot = (id: string, over: Partial<Lot> = {}): Lot => ({ id, title: id, status: 'done', estimate: 1, quickwin: false, visible: true, after: [], notes: [], tasks: [], problems: [], ...over });
const entry = (body: string) => parseEntry('a.md', `---\ntitle: A\ndate: 2026-10-11\ncreated: 2026-10-11T10:00Z\nlots: [L1]\nnocapture: maquette\n---\n${body}\n`);
const hyp = new Map([['L1', ['R3', 'R4']]]);
const SECTION = '## Hypothèses\n- R3 — erreur de chargement : message « Impossible de charger le prochain match. ». À confirmer.\n- R4 — rappel unique par match. Si faux, seul le bouton change.';

describe('newsIssues : section Hypothèses', () => {
  it('une entrée avec la section et une ligne par hypothèse est conforme', () => {
    expect(newsIssues([lot('L1')], [entry(`Texte.\n\n${SECTION}`)], gitRepo(), hyp)).toEqual([]);
  });

  it('sans la section, le lot est signalé avec ses règles', () => {
    const issues = newsIssues([lot('L1')], [entry('Texte.')], gitRepo(), hyp);
    expect(issues).toEqual([{ kind: 'missing-hypotheses', message: 'L1 : la fiche a des hypothèses (R3, R4) mais l\'entrée a.md n\'a pas la section « ## Hypothèses »' }]);
  });

  it('une hypothèse sans ligne est signalée', () => {
    const issues = newsIssues([lot('L1')], [entry('Texte.\n\n## Hypothèses\n- R3 — erreur : message.')], gitRepo(), hyp);
    expect(issues.map((i) => i.message)).toEqual(['L1 : la section « ## Hypothèses » de a.md n\'a pas de ligne pour R4']);
  });

  it('une ligne hors de la section ne compte pas', () => {
    const issues = newsIssues([lot('L1')], [entry('- R3 — dehors\n- R4 — dehors\n\n## Hypothèses\n\n## Autre\n- R3 — ailleurs\n- R4 — ailleurs')], gitRepo(), hyp);
    expect(issues.map((i) => i.message)).toEqual(["L1 : la section « ## Hypothèses » de a.md n'a pas de ligne pour R3, R4"]);
  });

  it('R1 ne valide pas R10, et R3 ne valide pas une phrase qui la cite au passage', () => {
    const issues = newsIssues([lot('L1')], [entry('## Hypothèses\n- R30 — x\n- voir R4 pour le reste')], gitRepo(), hyp);
    expect(issues.map((i) => i.message)).toEqual(["L1 : la section « ## Hypothèses » de a.md n'a pas de ligne pour R3, R4"]);
  });

  it('un lot sans hypothèse n\'a pas à avoir la section, et une section en trop est permise', () => {
    expect(newsIssues([lot('L1')], [entry('Texte.')], gitRepo(), new Map())).toEqual([]);
    expect(newsIssues([lot('L1')], [entry('Texte.')], gitRepo(), new Map([['L1', []]]))).toEqual([]);
  });

  it('une seule entrée du lot suffit quand il en a plusieurs', () => {
    const other = parseEntry('b.md', '---\ntitle: B\ndate: 2026-10-11\ncreated: 2026-10-11T11:00Z\nlots: [L1]\nnocapture: x\n---\nAutre.\n');
    expect(newsIssues([lot('L1')], [other, entry(SECTION)], gitRepo(), hyp)).toEqual([]);
  });

  it('un lot sans entrée n\'ajoute pas ce signalement (visible-without-entry le dit déjà)', () => {
    expect(newsIssues([lot('L1')], [], gitRepo(), hyp).map((i) => i.kind)).toEqual(['visible-without-entry']);
  });
});

describe('ficheHypotheses', () => {
  const ecrit = (root: string, name: string, fiche: unknown) => {
    mkdirSync(join(root, 'docs/specs', name), { recursive: true });
    writeFileSync(join(root, 'docs/specs', name, 'fiche.yaml'), stringify(fiche));
  };

  it('les règles hypothese de chaque fiche, par lot', () => {
    const root = gitRepo();
    const doc = parse(readFileSync(EXEMPLE, 'utf8')) as any;
    doc.ecran.lot = 'L1';
    ecrit(root, 'prochain-match', doc);
    const sans = { ...doc, ecran: { ...doc.ecran, lot: 'L2' }, regles: doc.regles.map((r: any) => ({ ...r, statut: 'sourcee', source: 's' })) };
    ecrit(root, 'autre', sans);
    expect([...ficheHypotheses(root, 'docs/specs')]).toEqual([['L1', ['R3', 'R4']]]);
  });

  it('dossier absent ou fiche illisible : rien, sans erreur', () => {
    const root = gitRepo();
    expect(ficheHypotheses(root, 'docs/specs').size).toBe(0);
    mkdirSync(join(root, 'docs/specs/x'), { recursive: true });
    writeFileSync(join(root, 'docs/specs/x/fiche.yaml'), ': : :\n  - [');
    expect(ficheHypotheses(root, 'docs/specs').size).toBe(0);
  });
});

describe('cadence news check', () => {
  const cli = (dir: string, ...argv: string[]) => {
    const out: string[] = [];
    const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-11' }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-10-11T10:12:00') });
    return { code, out: out.join('\n') };
  };

  it('signale une entrée sans la section tant que la fiche a des hypothèses, puis passe quand elle y est', () => {
    const dir = gitRepo();
    cli(dir, 'init', '--project', 'demo', '--no-hook');
    cli(dir, 'add', 'Écran', '--visible');
    cli(dir, 'start', 'L1');
    const doc = parse(readFileSync(EXEMPLE, 'utf8')) as any;
    doc.ecran.lot = 'L1';
    mkdirSync(join(dir, 'docs/specs/prochain-match'), { recursive: true });
    writeFileSync(join(dir, 'docs/specs/prochain-match/fiche.yaml'), stringify(doc));
    mkdirSync(join(dir, 'docs/nouveautes'), { recursive: true });
    const file = join(dir, 'docs/nouveautes/2026-10-11-ecran.md');
    const head = '---\ntitle: Écran\ndate: 2026-10-11\ncreated: 2026-10-11T10:00+00:00\nlots: [L1]\nnocapture: maquette\n---\n';
    writeFileSync(file, `${head}Un écran.\n`);
    const bad = cli(dir, 'news', 'check');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('L1 : la fiche a des hypothèses (R3, R4)');
    writeFileSync(file, `${head}Un écran.\n\n${SECTION}\n`);
    const ok = cli(dir, 'news', 'check');
    expect(ok.out).toContain('✓ Nouveautés cohérentes avec le plan');
    expect(ok.code).toBe(0);
  });
});
