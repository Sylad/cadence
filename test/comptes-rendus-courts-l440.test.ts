import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSectionOf } from './changelog-section.js';

// L440 : qa-reviewer et code-reviewer, appelés par le lead, rendent 5 lignes (verdict, bloquants, suites) et écrivent le rapport complet
// dans un fichier que le lead lit à la demande ; sans fichier nommé par le brief (revues de vague, usage à la main), le rapport reste complet.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const section = (text: string) => text.slice(text.indexOf('## Short reply'), text.indexOf('\n## ', text.indexOf('## Short reply') + 5));

describe.each(['code-reviewer', 'qa-reviewer'])('agents/%s.md — compte rendu court (L440)', (name) => {
  const agent = read(`agents/${name}.md`);
  const short = section(agent);

  it('R1 — une section « Short reply » existe et son déclencheur est la ligne « Report file: » du brief', () => {
    expect(short).not.toBe('');
    expect(short).toContain('Report file:');
  });

  it('R2 — le rapport complet est écrit dans ce fichier (hors dépôt), avant la réponse', () => {
    expect(short).toMatch(/full report[^.]*(written|write)[^.]*that file/i);
    expect(short).toMatch(/outside the repository/i);
    expect(short).toMatch(/before (you )?repl/i);
  });

  it('R3 — la réponse au lead tient en 5 lignes au plus : verdict, bloquants, suites, chemin du rapport', () => {
    expect(short).toMatch(/5 lines at most/i);
    for (const label of ['Verdict:', 'Blocking:', 'Follow-ups:', 'Report:']) expect(short).toContain(label);
  });

  it('R4 — sans « Report file: » dans le brief, le rapport reste complet (revues de vague, usage à la main)', () => {
    expect(short).toMatch(/no (`?Report file:`? line|report file)[^.]*(full|complete) report/i);
  });

  it('R5 — le verdict reste la dernière ligne du rapport du fichier, et le chemin est celui du brief, jamais un autre', () => {
    expect(short).toMatch(/last line of the file/i);
    expect(short).toMatch(/path (the brief gives|given by the brief)/i);
  });

  it('R6 — un fichier non écrit (échec) est dit dans la réponse : le rapport complet est alors rendu en entier', () => {
    expect(short).toMatch(/cannot (be )?write|fails? to write|could not write/i);
    expect(short).toMatch(/(whole|full|complete) report in (the|your) reply/i);
  });
});

describe('skills/lead/SKILL.md et docs — le lead demande le fichier et le lit à la demande (L440)', () => {
  const lead = read('skills/lead/SKILL.md');
  const check = lead.slice(lead.indexOf('## 3. Check'), lead.indexOf('## 4. Delivery'));
  const delivery = lead.slice(lead.indexOf('## 4. Delivery'), lead.indexOf('## 5. Close'));

  it('R7 — la section 3 donne au code-reviewer une ligne « Report file: » et lit le fichier seulement pour un bloquant ou pour enregistrer le verdict', () => {
    expect(check).toContain('Report file:');
    expect(check).toMatch(/read (the )?(report )?file only|only when/i);
  });

  it('R8 — la section 4 donne la même ligne au qa-reviewer', () => {
    expect(delivery).toContain('Report file:');
  });

  it('R9 — docs/skills.md et docs/lead.md décrivent le compte rendu court', () => {
    expect(read('docs/skills.md')).toContain('Report file:');
    expect(read('docs/lead.md')).toContain('Report file:');
  });

  it('R10 — le CHANGELOG cite L440 et la ligne « Report file: »', () => {
    expect(changelogSectionOf(read('CHANGELOG.md'), /\(L440[,)]/)).toContain('Report file:');
  });
});
