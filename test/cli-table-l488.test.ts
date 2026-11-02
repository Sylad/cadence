// L488 : cli.ts découpé en modules par famille de commandes, dispatch réduit à une table. Sans changement de comportement :
// ces tests tiennent ce que la table ne doit pas perdre (chaque commande répond, une clé héritée d'Object n'est pas une commande,
// l'ordre « sans plan » puis « avec plan » du switch d'avant).
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

async function raf(dir: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-02', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T09:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const COMMANDES = [
  'init', 'add', 'start', 'done', 'drop', 'archive', 'status', 'todo', 'note', 'did', 'title', 'uses', 'move', 'public', 'screen', 'estimate', 'visible',
  'spec', 'ux', 'review', 'commits', 'show', 'list', 'now', 'ignore', 'docs-ok', 'check', 'gantt', 'hook', 'session', 'deliver', 'verify', 'skills', 'local', 'news',
  'lead', 'config', 'corrections', 'perf', 'ref', 'release', 'migrate',
];

describe('L488 — cli.ts : la table de commandes', () => {
  it('R1 — chaque commande du switch d\'avant répond à son propre usage, jamais « commande inconnue »', async () => {
    const dir = gitRepo();
    await raf(dir, {}, 'init', '--project', 'demo');
    for (const commande of COMMANDES) {
      const r = await raf(dir, {}, commande);
      expect(r.err, commande).not.toContain('commande inconnue');
    }
  });

  it('R2 — un nom qui est une clé d\'Object.prototype n\'est pas une commande : « commande inconnue », code 2', async () => {
    const dir = gitRepo();
    await raf(dir, {}, 'init', '--project', 'demo');
    for (const nom of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = await raf(dir, {}, nom);
      expect(r.code, nom).toBe(2);
      expect(r.err, nom).toContain(`commande inconnue : ${nom}`);
    }
  });

  it('R3 — une commande inconnue lit d\'abord la configuration : un cadence.yaml fautif est signalé avant « commande inconnue »', async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan: [pas, un, chemin]\n');
    const r = await raf(dir, {}, 'inexistante');
    expect(r.code).toBe(2);
    expect(r.err).not.toContain('commande inconnue');
  });

  it('R4 — les commandes sans plan (lead, config, perf, corrections, release, migrate, spec check, ref, session --all) ne lisent pas un cadence.yaml fautif', async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan: [pas, un, chemin]\n');
    for (const argv of [['lead', 'tour'], ['config', 'set', 'k', 'v'], ['perf'], ['corrections'], ['release'], ['migrate', 'extra'], ['spec', 'check'], ['ref', 'check'], ['session', 'start', '--all']]) {
      const r = await raf(dir, {}, ...argv);
      expect(r.err, argv.join(' ')).not.toContain('plan');
    }
  });

  it('R5 — ref coverage lit le plan (lots faits qui citent les éléments), les autres ref non', async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan: [pas, un, chemin]\n');
    const coverage = await raf(dir, {}, 'ref', 'coverage', 'inventaire.json');
    expect(coverage.err).toContain('plan doit être');
    const check = await raf(dir, {}, 'ref', 'check', 'inventaire.json');
    expect(check.err).not.toContain('plan doit être');
  });

  it('R6 — done, ux, review et deliver sont refusés dans une vague orchestrée, avant toute lecture du lot', async () => {
    const dir = gitRepo();
    await raf(dir, {}, 'init', '--project', 'demo');
    for (const commande of ['done', 'ux', 'review', 'deliver']) {
      const r = await raf(dir, { CADENCE_ORCHESTRATED: 'v1' }, commande, 'L9');
      expect(r.code, commande).toBe(2);
      expect(r.err, commande).toContain(`${commande} refusé pendant une vague orchestrée (v1)`);
    }
  });

  it('R7 — --all et --depth restent refusés hors session start|close, lead et config', async () => {
    const dir = gitRepo();
    await raf(dir, {}, 'init', '--project', 'demo');
    expect((await raf(dir, {}, 'list', '--all')).err).toContain('--all ne va qu\'avec session start ou session close');
    expect((await raf(dir, {}, 'list', '--depth', '2')).err).toContain('--depth ne va qu\'avec session start ou session close');
  });

  it('R8 — spec distingue check|qa (sans plan), green, reseal et on|off (avec plan)', async () => {
    const dir = gitRepo();
    await raf(dir, {}, 'init', '--project', 'demo');
    await raf(dir, {}, 'add', 'A');
    expect((await raf(dir, {}, 'spec', 'check')).err).toContain('usage : cadence spec check|qa');
    expect((await raf(dir, {}, 'spec', 'green')).err).toContain('usage : cadence spec green <lot>');
    expect((await raf(dir, {}, 'spec', 'L1', 'on')).code).toBe(0);
    expect((await raf(dir, {}, 'spec', 'L1')).err).toContain('usage : raf spec <id> on|off');
  });
});
