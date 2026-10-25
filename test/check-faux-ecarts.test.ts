import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { audit } from '../src/audit.js';
import { readPlanConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { commit, gitRepo } from './helpers.js';

const CONFIG = (fields: string) => `plan:
  path: suivi/taches.yaml
  project: demo
  since: 2026-09-01
  lots: taches
  fields:
    title: titre
    status: etat
    started: demarre_le
    parent: parent
${fields}  statuses:
    todo: prevu
    doing: en_cours
    done: livre
`;

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Un dépôt dont le plan est tenu par un autre outil (lecture seule), puis les écarts de `raf check` au jour donné. */
function ecartsDe(taches: string, fields: string, today: string): string[] {
  const dir = gitRepo();
  write(join(dir, 'cadence.yaml'), CONFIG(fields));
  write(join(dir, 'suivi/taches.yaml'), taches);
  commit(dir, 'chore: plan', '2026-09-01T09:00:00');
  commit(dir, 'feat(B28.6): sous-lot livré', '2026-10-24T10:00:00');
  const cfg = readPlanConfig(join(dir, 'cadence.yaml'), dir)!;
  const plan = Plan.load(join(dir, cfg.path!), cfg.settings);
  return audit(plan, dir, join(dir, 'news'), today).map((i) => i.message);
}

const PARENT_ET_SOUS_LOT = (parentEtat: string, enfantEtat: string) => `taches:
- id: B28
  titre: Gros chantier
  etat: ${parentEtat}
  demarre_le: '2026-09-27'
- id: B28.6
  titre: Sixième morceau
  etat: ${enfantEtat}
  demarre_le: '2026-10-24'
  parent: B28
`;

describe('lot parent en cours et sous-lots (L321)', () => {
  it('R1 — un lot parent dont un sous-lot (parent:) a un commit récent n’est pas signalé « sans commit depuis N j »', () => {
    const ecarts = ecartsDe(PARENT_ET_SOUS_LOT('en_cours', 'livre'), '', '2026-10-25');
    expect(ecarts.filter((m) => m.includes('sans commit'))).toEqual([]);
  });

  it('R2 — un lot parent dont un sous-lot est en cours (actif, démarré récemment) n’est pas signalé', () => {
    const ecarts = ecartsDe(PARENT_ET_SOUS_LOT('en_cours', 'en_cours'), '', '2026-10-30');
    expect(ecarts.filter((m) => m.startsWith('B28 '))).toEqual([]);
  });

  it('R3 — le lot parent reste signalé quand ni lui ni ses sous-lots n’ont d’activité récente', () => {
    const ecarts = ecartsDe(PARENT_ET_SOUS_LOT('en_cours', 'livre'), '', '2026-11-20');
    expect(ecarts.filter((m) => m.startsWith('B28 ') && m.includes('sans commit'))).toHaveLength(1);
  });
});

const REVUE_UX = `taches:
- id: R1
  titre: Revue UX — écran Bilans
  etat: prevu
`;

describe('revue UX sans visible: sur un plan en lecture seule (L321)', () => {
  it('R4 — sans champ visible mappé, l’écart dit que le plan ne porte pas visible et renvoie à la config, sans commande raf', () => {
    const [msg] = ecartsDe(REVUE_UX, '', '2026-10-25').filter((m) => m.startsWith('R1 '));
    expect(msg).toContain('ne porte pas visible');
    expect(msg).toContain('configuration');
    expect(msg).not.toContain('raf visible');
    expect(msg).not.toContain('raf add');
  });

  it('R5 — avec visible mappé, l’écart demande de poser visible avec l’outil du projet, sans commande raf', () => {
    const [msg] = ecartsDe(REVUE_UX, '    visible: visible\n', '2026-10-25').filter((m) => m.startsWith('R1 '));
    expect(msg).toContain('outil du projet');
    expect(msg).not.toContain('raf visible');
    expect(msg).not.toContain('raf add');
  });

  it('R6 — sur un plan raf, l’écart garde la commande « raf visible »', () => {
    const dir = gitRepo();
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo');
    plan.add('Revue UX — écran Bilans', '2026-09-27');
    const [msg] = audit(plan, dir, join(dir, 'news'), '2026-09-28').map((i) => i.message).filter((m) => m.includes('visible'));
    expect(msg).toContain('raf visible L1 on');
  });
});
