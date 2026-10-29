import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSectionOf } from './changelog-section.js';

// L426 : les consignes de l'agent qui pousse disent que le sha poussé doit avoir un verdict vert de `cadence verify --gate`,
// que la tête de main est le plus souvent un commit de plan sans verdict (porte rejouée en entier), et ce que vaut CADENCE_PUSH_UNGATED=1.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const lead = read('skills/lead/SKILL.md');
const delivery = lead.slice(lead.indexOf('## 4. Delivery'), lead.indexOf('## 5. Close'));
const deliver = read('skills/deliver/SKILL.md');
const push = deliver.slice(deliver.indexOf('## Delivering a commit that is not HEAD'), deliver.indexOf('## Where to run'));

describe('skills lead et deliver — le push demande un verdict vert de la porte (L426)', () => {
  it('R18 — la section 4 du skill lead dit que le hook refuse un push dont le sha n\'a pas de verdict vert, et que la tête de main (commit de plan après raf done) n\'en a pas : rejouer la porte à ce sha avant de pousser', () => {
    expect(delivery).toContain('cadence verify --gate --sha');
    expect(delivery).toMatch(/plan commit/);
    expect(delivery).toMatch(/no verdict|has no (green )?verdict/);
    expect(delivery).toMatch(/replay(s|ed)? (the )?(whole |full )?gate/);
  });

  it('R18 — la section 4 du skill lead nomme CADENCE_PUSH_UNGATED=1 comme passe-outre explicite, pas comme habitude', () => {
    expect(delivery).toContain('CADENCE_PUSH_UNGATED=1');
    expect(delivery).toMatch(/CADENCE_PUSH_UNGATED=1[^.]*\b(never|not) (the )?(routine|habit|the rule)/i);
  });

  it('R19 — le skill deliver, au push du sha, dit que le sha poussé doit avoir un verdict vert (verify --gate --sha) et nomme CADENCE_PUSH_UNGATED=1', () => {
    expect(push).toContain('cadence verify --gate --sha <sha>');
    expect(push).toContain('CADENCE_PUSH_UNGATED=1');
    expect(push).toMatch(/exit(s)? 3|refuse/);
  });

  it('R19 — docs/lead.md (étape Delivery) dit la même chose que le skill : verdict vert du sha poussé, commit de plan sans verdict', () => {
    const doc = read('docs/lead.md');
    const step = doc.slice(doc.indexOf('6. **Delivery.**'), doc.indexOf('7. **Threshold'));
    expect(step).toContain('cadence verify --gate --sha');
    expect(step).toMatch(/plan commit/);
    expect(step).toContain('CADENCE_PUSH_UNGATED=1');
  });

  it('R19 — le CHANGELOG cite la mise à jour des skills lead et deliver', () => {
    const section = changelogSectionOf(read('CHANGELOG.md'), '(L426,');
    expect(section).toMatch(/`lead` and `deliver` skills/);
  });
});
