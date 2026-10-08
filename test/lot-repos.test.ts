import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlanConfig } from '../src/config.js';
import { Plan, RafError } from '../src/plan.js';
import { tempDir } from './helpers.js';

const write = (file: string, text: string): string => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  return file;
};

describe('clé de lot `repos:` (L62)', () => {
  it('un plan natif lit la liste des dépôts de travail d\'un lot ; absente, la liste est vide', () => {
    const dir = tempDir();
    const file = write(join(dir, 'raf.yaml'), 'version: 1\nproject: demo\nprefix: B\nlots:\n- { id: B1, title: un, status: todo, repos: [../gitops, ../autre] }\n- { id: B2, title: deux, status: todo }\n');
    const plan = Plan.load(file);
    expect(plan.lot('B1').repos).toEqual([{ path: '../gitops' }, { path: '../autre' }]);
    expect(plan.lot('B2').repos ?? []).toEqual([]);
  });

  it('une chaîne seule vaut une liste d\'un dépôt ; une entrée vide ou non textuelle est écartée', () => {
    const dir = tempDir();
    const file = write(join(dir, 'raf.yaml'), 'version: 1\nproject: demo\nprefix: B\nlots:\n- { id: B1, title: un, status: todo, repos: ../gitops }\n- { id: B2, title: deux, status: todo, repos: [../a, "", 7, "  ../b  "] }\n');
    const plan = Plan.load(file);
    expect(plan.lot('B1').repos).toEqual([{ path: '../gitops' }]);
    expect(plan.lot('B2').repos).toEqual([{ path: '../a' }, { path: '../b' }]);
  });

  it('une entrée peut être un objet { path, cite } ; un cite vide ou non textuel est ignoré, un objet sans chemin écarté', () => {
    const dir = tempDir();
    const file = write(join(dir, 'raf.yaml'), 'version: 1\nproject: demo\nprefix: B\nlots:\n- { id: B1, title: un, status: todo, repos: [../a, { path: ../developpeur-gitops, cite: " ol-companion " }, { path: ../b, cite: "" }, { path: ../c, cite: 3 }, { cite: x }] }\n- { id: B2, title: deux, status: todo, repos: { path: ../seul, cite: App } }\n');
    const plan = Plan.load(file);
    expect(plan.lot('B1').repos).toEqual([{ path: '../a' }, { path: '../developpeur-gitops', cite: 'ol-companion' }, { path: '../b' }, { path: '../c' }]);
    expect(plan.lot('B2').repos).toEqual([{ path: '../seul', cite: 'App' }]);
  });

  it('un plan en lecture seule la déclare par fields.repos (cadence.yaml), chaînes et objets mêlés', () => {
    const dir = tempDir();
    const cfg = readPlanConfig(write(join(dir, 'cadence.yaml'), 'plan:\n  lots: taches\n  fields: { title: titre, status: etat, repos: depots }\n  statuses: { todo: prevu }\n'))!;
    const plan = Plan.load(write(join(dir, 'p.yaml'), 'taches:\n- { id: B64, titre: x, etat: prevu, depots: [../aetherwx-gitops, { path: ../developpeur-gitops, cite: ol-companion }] }\n- { id: B65, titre: y, etat: prevu }\n'), cfg.settings);
    expect(plan.lot('B64').repos).toEqual([{ path: '../aetherwx-gitops' }, { path: '../developpeur-gitops', cite: 'ol-companion' }]);
    expect(plan.lot('B65').repos ?? []).toEqual([]);
  });

  it('sans fields.repos, la clé du fichier s\'appelle `repos`', () => {
    const dir = tempDir();
    const cfg = readPlanConfig(write(join(dir, 'cadence.yaml'), 'plan:\n  lots: taches\n  fields: { title: titre, status: etat }\n  statuses: { todo: prevu }\n'))!;
    const plan = Plan.load(write(join(dir, 'p.yaml'), 'taches:\n- { id: B64, titre: x, etat: prevu, repos: [../g] }\n'), cfg.settings);
    expect(plan.lot('B64').repos).toEqual([{ path: '../g' }]);
  });
});

describe('verdict de revue : sha lu de chaque dépôt', () => {
  const planWith = () => {
    const dir = tempDir();
    const file = write(join(dir, 'raf.yaml'), 'version: 1\nproject: demo\nprefix: B\nsince: 2026-09-01\nlots:\n- { id: B1, title: un, status: doing, repos: [../gitops] }\n');
    return { file, plan: Plan.load(file) };
  };

  it('recordReview range le sha de chaque dépôt voisin à côté du commit du projet, relus à la lecture', () => {
    const { file, plan } = planWith();
    plan.recordReview('B1', 'conforme', '2026-10-08', 'aaa111', { '../gitops': 'bbb222' });
    plan.save();
    const back = Plan.load(file).lot('B1');
    expect(back.review).toMatchObject({ verdict: 'conforme', commit: 'aaa111', repos: { '../gitops': 'bbb222' } });
  });

  it('un dépôt voisin sans commit du lot s\'écrit null', () => {
    const { file, plan } = planWith();
    plan.recordReview('B1', 'conforme', '2026-10-08', null, { '../gitops': null });
    plan.save();
    expect(Plan.load(file).lot('B1').review).toMatchObject({ commit: null, repos: { '../gitops': null } });
  });

  it('sans dépôt voisin, le verdict garde sa forme d\'avant (pas de clé repos)', () => {
    const { file, plan } = planWith();
    plan.recordReview('B1', 'conforme', '2026-10-08', 'aaa111');
    plan.save();
    const back = Plan.load(file).lot('B1');
    expect(back.review).not.toHaveProperty('repos');
    expect(plan).toBeDefined();
    expect(() => plan.recordReview('B1', ' ', '2026-10-08', null, { '../gitops': null })).toThrow(RafError);
  });
});
