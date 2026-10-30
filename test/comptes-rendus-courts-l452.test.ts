import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSectionOf } from './changelog-section.js';

// L452 : ux-reviewer et doc-keeper, appelés par le lead, rendent 15 lignes au plus (verdict, constats classés avec leur règle ou mesure,
// non vérifié, sous-tâches, chemin) et écrivent le détail mesuré dans un fichier que le lead lit à la demande (suite de L440 pour code-reviewer et qa-reviewer, 5 lignes).
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const section = (text: string) => text.slice(text.indexOf('## Short reply'), text.indexOf('\n## ', text.indexOf('## Short reply') + 5));

describe.each(['ux-reviewer', 'doc-keeper'])('agents/%s.md — compte rendu court (L452)', (name) => {
  const agent = read(`agents/${name}.md`);
  const short = section(agent);

  it('R1 — une section « Short reply » existe et son déclencheur est la ligne « Report file: » du brief', () => {
    expect(short).not.toBe('');
    expect(short).toContain('Report file:');
    expect(short).toMatch(/only trigger/i);
  });

  it('R2 — le détail mesuré est écrit dans ce fichier (hors dépôt), avant la réponse', () => {
    expect(short).toMatch(/full report[^.]*(written|write)[^.]*that file/i);
    expect(short).toMatch(/outside the repository/i);
    expect(short).toMatch(/before (you )?repl/i);
  });

  it('R3 — la réponse tient en 15 lignes au plus : verdict, constats avec règle ou mesure, non vérifié, sous-tâches, chemin', () => {
    expect(short).toMatch(/15 lines at most/i);
    for (const label of ['Verdict:', 'Findings:', 'Not verified:', 'Sub-tasks:', 'Report:']) expect(short).toContain(label);
    expect(short).toMatch(/rule|measure/i);
  });

  it('R4 — sans « Report file: » dans le brief, le rapport reste complet (orchestrate, usage à la main)', () => {
    expect(short).toMatch(/no (`?Report file:`? line|report file)[^.]*(full|complete) report/i);
  });

  it('R5 — le verdict reste la dernière ligne du fichier, et le chemin est celui du brief, jamais un autre', () => {
    expect(short).toMatch(/last line of the file/i);
    expect(short).toMatch(/path (the brief gives|given by the brief)/i);
  });

  it('R6 — un fichier non écrit est dit dans la réponse : le rapport complet est alors rendu en entier', () => {
    expect(short).toMatch(/cannot (be )?write|fails? to write|could not write/i);
    expect(short).toMatch(/(whole|full|complete) report in (the|your) reply/i);
  });
});

describe('agents/ux-reviewer.md — les captures restent là où le brief les place (L452)', () => {
  it('R7 — le fichier de rapport ne remplace pas le dossier des captures : le chemin du dossier est rendu avec le chemin du rapport', () => {
    const short = section(read('agents/ux-reviewer.md'));
    expect(short).toMatch(/captures?[^.]*(folder|directory)/i);
  });
});

describe('skills/lead/SKILL.md et docs — le lead demande le fichier à ux-reviewer et doc-keeper (L452)', () => {
  const lead = read('skills/lead/SKILL.md');
  const hasLine = (text: string, agent: string) => new RegExp(`${agent}[\\s\\S]{0,1200}Report file:|Report file:[\\s\\S]{0,1200}${agent}`).test(text);

  it('R8 — le skill lead donne la ligne « Report file: » au ux-reviewer (lot visible)', () => {
    expect(hasLine(lead.slice(lead.indexOf('A lot that adds or changes a screen is `visible`'), lead.indexOf('### 2b.')), 'ux-reviewer')).toBe(true);
  });

  it('R9 — le skill lead donne la ligne « Report file: » au doc-keeper (point 0b de la section 3)', () => {
    const zero = lead.slice(lead.indexOf('0b. For a lot delegated by hand'), lead.indexOf('\n1. The `code-reviewer`'));
    expect(zero).toContain('Report file:');
  });

  it('R10 — docs/skills.md et docs/lead.md décrivent le compte rendu court des quatre agents', () => {
    const skills = read('docs/skills.md');
    expect(skills.match(/L452/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(read('docs/lead.md')).toMatch(/L452/);
  });

  it('R11 — le CHANGELOG cite L452 et la ligne « Report file: »', () => {
    expect(changelogSectionOf(read('CHANGELOG.md'), /\(L452[,)]/)).toContain('Report file:');
  });
});
