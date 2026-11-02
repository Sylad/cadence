import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { gitRepo, tempDir } from './helpers.js';

// L464 — plan.extras : des champs d'extension déclarés par le projet, validés, conservés, ajoutables par `raf add --set`, montrés par `raf show`, exportés par `raf list --json`.
const PLAN = '.cadence/raf.yaml';
const EXTRAS = "plan:\n  extras:\n    theme: { enum: [infra, ui, data] }\n    owner: { default: claude }\n";

function cadence(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un projet avec le cadence.yaml donné et un plan raf initialisé. */
function project(yaml: string) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), yaml);
  cadence(dir, 'init', '--project', 'demo', '--no-hook');
  return dir;
}
const planText = (dir: string) => readFileSync(join(dir, PLAN), 'utf8');

describe('R1 — la clé plan.extras se lit et se valide', () => {
  const read = (yaml: string) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    return () => readPlanConfig(join(dir, 'cadence.yaml'));
  };
  it('R1 — enum et default lus par champ', () => {
    expect(read(EXTRAS)()?.settings.extras).toEqual({ theme: { enum: ['infra', 'ui', 'data'] }, owner: { default: 'claude' } });
  });
  it('R1 — un champ sans règle (null) est libre : texte quelconque', () => {
    expect(read('plan:\n  extras:\n    fiche: {}\n')()?.settings.extras).toEqual({ fiche: {} });
  });
  it('R1 — mauvaise forme refusée en nommant la clé', () => {
    expect(read('plan:\n  extras: [theme]\n')).toThrow(/plan\.extras doit être un objet/);
    expect(read('plan:\n  extras:\n    theme: ui\n')).toThrow(/plan\.extras\.theme doit être un objet/);
    expect(read('plan:\n  extras:\n    theme: { enum: [] }\n')).toThrow(/plan\.extras\.theme\.enum/);
    expect(read('plan:\n  extras:\n    theme: { enum: [a, 3] }\n')).toThrow(/plan\.extras\.theme\.enum/);
    expect(read('plan:\n  extras:\n    theme: { enum: [a, a] }\n')).toThrow(/plan\.extras\.theme\.enum.*deux fois/);
    expect(read('plan:\n  extras:\n    theme: { color: red }\n')).toThrow(/plan\.extras\.theme\.color inconnu/);
    expect(read('plan:\n  extras:\n    theme: { default: 3 }\n')).toThrow(/plan\.extras\.theme\.default/);
    expect(read('plan:\n  extras:\n    theme: { enum: [a], default: b }\n')).toThrow(/plan\.extras\.theme\.default « b » hors de enum/);
  });
  it('R1 — un nom invalide ou qui prend la place d\'un champ de raf est refusé', () => {
    expect(read('plan:\n  extras:\n    Thème: {}\n')).toThrow(/plan\.extras\.Thème/);
    expect(read('plan:\n  extras:\n    status: {}\n')).toThrow(/plan\.extras\.status.*champ de raf/);
    expect(read('plan:\n  extras:\n    tasks: {}\n')).toThrow(/plan\.extras\.tasks.*champ de raf/);
  });
  it('R1 — refusé avec un plan lu au format d\'un autre outil (lecture seule)', () => {
    expect(read('plan:\n  path: t.yaml\n  lots: taches\n  extras:\n    theme: {}\n')).toThrow(/plan\.extras.*autre outil/);
  });
});

describe('R2 — la valeur posée sur un lot est validée par raf check', () => {
  const withLot = (dir: string, lines: string) => {
    const text = planText(dir).replace(/lots:.*\n/, 'lots:\n') + lines;
    writeFileSync(join(dir, PLAN), text);
  };
  it('R2 — une valeur hors enum est un bad-field qui nomme le lot, le champ et les valeurs permises', () => {
    const dir = project(EXTRAS);
    withLot(dir, '- id: L1\n  title: a\n  status: todo\n  estimate: 1\n  theme: zzz\n');
    const r = cadence(dir, 'check');
    expect(r.out + r.err).toMatch(/L1 : theme « zzz » hors de enum \(infra, ui, data\)/);
  });
  it('R2 — une valeur qui n\'est pas un texte (nombre, liste, vide) est refusée', () => {
    const dir = project(EXTRAS);
    withLot(dir, '- id: L1\n  title: a\n  status: todo\n  estimate: 1\n  theme: 3\n- id: L2\n  title: b\n  status: todo\n  estimate: 1\n  theme: [ui]\n- id: L3\n  title: c\n  status: todo\n  estimate: 1\n  theme: ""\n');
    const r = cadence(dir, 'check');
    for (const id of ['L1', 'L2', 'L3']) expect(r.out + r.err).toMatch(new RegExp(`${id} : theme .*texte non vide attendu`));
  });
  it('R2 — une valeur valide, ou l\'absence d\'un champ sans default, ne signale rien', () => {
    const dir = project(EXTRAS);
    withLot(dir, '- id: L1\n  title: a\n  status: todo\n  estimate: 1\n  theme: ui\n- id: L2\n  title: b\n  status: todo\n  estimate: 1\n');
    const r = cadence(dir, 'check');
    expect(r.out + r.err).not.toMatch(/theme/);
  });
  it('R2 — une clé non déclarée n\'est ni validée ni refusée', () => {
    const dir = project(EXTRAS);
    withLot(dir, '- id: L1\n  title: a\n  status: todo\n  estimate: 1\n  couleur: rouge\n');
    expect(cadence(dir, 'check').out + cadence(dir, 'check').err).not.toMatch(/couleur/);
  });
});

describe('R3 — raf add --set pose un champ déclaré', () => {
  it('R3 — --set theme=ui écrit la clé sur le lot, après les clés de raf et avant created', () => {
    const dir = project(EXTRAS);
    const r = cadence(dir, 'add', 'Un lot', '--set', 'theme=ui');
    expect(r.code).toBe(0);
    const text = planText(dir);
    expect(text).toMatch(/theme: ui\n\s+created: 2026-11-02/);
    expect(text).not.toMatch(/owner/);
    expect(cadence(dir, 'check').out).not.toMatch(/theme/);
  });
  it('R3 — plusieurs --set, une valeur qui contient « = » est gardée entière', () => {
    const dir = project("plan:\n  extras:\n    theme: {}\n    fiche: {}\n");
    expect(cadence(dir, 'add', 'x', '--set', 'theme=a', '--set', 'fiche=docs/a=b.md').code).toBe(0);
    expect(planText(dir)).toMatch(/theme: a\n\s+fiche: docs\/a=b\.md/);
  });
  it('R3 — refus sans rien écrire : champ non déclaré, valeur hors enum, sans « = », valeur vide, champ posé deux fois', () => {
    const dir = project(EXTRAS);
    const before = planText(dir);
    const refuse = (re: RegExp, ...set: string[]) => {
      const r = cadence(dir, 'add', 'x', ...set.flatMap((s) => ['--set', s]));
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(re);
      expect(planText(dir)).toBe(before);
    };
    refuse(/couleur.*non déclaré.*theme, owner/, 'couleur=rouge');
    refuse(/theme « zzz » hors de enum \(infra, ui, data\)/, 'theme=zzz');
    refuse(/--set attend champ=valeur/, 'theme');
    refuse(/--set attend champ=valeur/, 'theme=');
    refuse(/--set attend champ=valeur/, '=ui');
    refuse(/theme.*deux fois/, 'theme=ui', 'theme=data');
  });
  it('R3 — sans plan.extras déclaré, --set est refusé en le disant', () => {
    const dir = project('plan:\n  project: demo\n');
    const r = cadence(dir, 'add', 'x', '--set', 'theme=ui');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/aucun champ d'extension déclaré \(cadence\.yaml : plan\.extras\)/);
  });
  it('R3 — --set sur une sous-tâche (--parent) est refusé', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'parent');
    const r = cadence(dir, 'add', 'sous', '--parent', 'L1', '--set', 'theme=ui');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--set se pose sur un lot, pas sur une sous-tâche/);
  });
});

describe('R4 — les champs d\'extension sont conservés à la réécriture', () => {
  it('R4 — start, note, done, titre : la clé déclarée et une clé non déclarée sont toujours là', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'Un lot', '--set', 'theme=data');
    writeFileSync(join(dir, PLAN), planText(dir).replace(/^( +)theme: data$/m, '$1theme: data\n$1couleur: rouge # à garder'));
    expect(cadence(dir, 'start', 'L1').code).toBe(0);
    expect(cadence(dir, 'note', 'L1', 'une note').code).toBe(0);
    expect(cadence(dir, 'title', 'L1', 'Autre titre').code).toBe(0);
    expect(cadence(dir, 'done', 'L1', '--force').code).toBe(0);
    expect(planText(dir)).toMatch(/theme: data\n\s+couleur: rouge # à garder/);
  });
  it('R4 — raf archive emporte les clés avec le lot, et le lot archivé les montre encore', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'Un lot', '--set', 'theme=infra');
    cadence(dir, 'start', 'L1');
    cadence(dir, 'done', 'L1', '--force');
    expect(cadence(dir, 'archive').code).toBe(0);
    expect(planText(dir)).not.toMatch(/L1/);
    expect(cadence(dir, 'show', 'L1').out).toMatch(/theme : infra/);
  });
});

describe('R5 — raf show et raf list --json montrent les champs d\'extension', () => {
  it('R5 — show écrit « champ : valeur » pour chaque champ posé, la valeur par défaut comprise', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'Un lot', '--set', 'theme=ui');
    const out = cadence(dir, 'show', 'L1').out;
    expect(out).toMatch(/^theme : ui$/m);
    expect(out).toMatch(/^owner : claude$/m);
  });
  it('R5 — show ne montre pas un champ absent sans default', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'Un lot');
    expect(cadence(dir, 'show', 'L1').out).not.toMatch(/^theme/m);
  });
  it('R5 — la valeur écrite l\'emporte sur le default', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'Un lot', '--set', 'owner=sylvain');
    expect(cadence(dir, 'show', 'L1').out).toMatch(/^owner : sylvain$/m);
  });
  it('R5 — list --json : un tableau, tous les lots, les champs d\'extension sous extras ; --status filtre', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'A', '--set', 'theme=ui');
    cadence(dir, 'add', 'B');
    cadence(dir, 'start', 'L2');
    const all = JSON.parse(cadence(dir, 'list', '--json').out);
    expect(all.map((l: { id: string }) => l.id)).toEqual(['L1', 'L2']);
    expect(all[0]).toMatchObject({ id: 'L1', title: 'A', status: 'todo', estimate: 1, extras: { theme: 'ui', owner: 'claude' } });
    expect(all[1].extras).toEqual({ owner: 'claude' });
    expect(JSON.parse(cadence(dir, 'list', '--json', '--status', 'doing').out).map((l: { id: string }) => l.id)).toEqual(['L2']);
  });
  it('R5 — list --json sans plan.extras : pas de clé extras, un tableau vide pour un plan vide', () => {
    const dir = project('plan:\n  project: demo\n');
    expect(JSON.parse(cadence(dir, 'list', '--json').out)).toEqual([]);
    cadence(dir, 'add', 'A');
    expect(JSON.parse(cadence(dir, 'list', '--json').out)[0]).not.toHaveProperty('extras');
  });
  it('R5 — list --json : les noms du contrat (clés du fichier), sans les champs internes', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'A', '--set', 'theme=ui');
    cadence(dir, 'docs-ok', 'L1', '--reason', 'inchangée');
    const lot = JSON.parse(cadence(dir, 'list', '--json').out)[0];
    expect(Object.keys(lot).sort()).toEqual(['after', 'created', 'docs_ok', 'estimate', 'extras', 'id', 'notes', 'quickwin', 'status', 'tasks', 'title', 'visible']);
    expect(lot.docs_ok).toEqual({ date: '2026-11-02', reason: 'inchangée' });
  });
  it('R5 — l\'aide et le tableau des commandes citent list --json', () => {
    expect(cadence(project(EXTRAS), '--help').out).toMatch(/raf list \[--status [^\]]*\] \[--json\]/);
    expect(readFileSync(join(__dirname, '../docs/raf.md'), 'utf8')).toMatch(/\| `raf list \[--status s\] \[--json\]` \|/);
  });
  it('R5 — list sans --json garde sa sortie d\'avant', () => {
    const dir = project(EXTRAS);
    cadence(dir, 'add', 'A', '--set', 'theme=ui');
    expect(cadence(dir, 'list').out).toMatch(/^L1\s+todo\s+A$/);
  });
});
