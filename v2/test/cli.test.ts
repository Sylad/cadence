import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run, type Io } from '../src/cli.js';
import { cmdRun } from '../src/run/cli.js';
import { dossierTemp } from './temp.js';

export function ioTest(env: NodeJS.ProcessEnv = {}): Io & { sortie: string[]; erreurs: string[] } {
  const sortie: string[] = []; const erreurs: string[] = [];
  return { cwd: '/', env, now: () => new Date('2026-11-09T10:00:00Z'), out: (l) => sortie.push(l), err: (l) => erreurs.push(l), sortie, erreurs };
}

describe('cadence2', () => {
  it('sans argument, affiche l\'aide et sort en 0', async () => {
    const io = ioTest();
    expect(await run([], io)).toBe(0);
    expect(io.sortie.join('\n')).toMatch(/cadence2 bench/);
  });
  it('commande inconnue : code 2', async () => {
    const io = ioTest();
    expect(await run(['zorglub'], io)).toBe(2);
    expect(io.erreurs[0]).toMatch(/inconnue/);
  });
});

describe('cadence run : aide et options inconnues (issue #54)', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  function depot(): string {
    const repo = join(dossierTemp('run-aide-'), 'projet');
    mkdirSync(repo, { recursive: true }); writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    return repo;
  }
  const rienCree = (repo: string) => {
    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(existsSync(join(dirname(repo), '.cadence-run'))).toBe(false);
  };

  for (const args of [['--help'], ['-h'], ['--fond', '--help'], ['Crée x', '--help']]) {
    it(`${args.join(' ')} : l'usage sur la sortie, code 0, ni worktree ni branche ni état`, async () => {
      const repo = depot(), io = { ...ioTest(), cwd: repo };
      expect(await run(['run', ...args], io)).toBe(0);
      expect(io.sortie.join('\n')).toMatch(/cadence run "<demande>"/);
      expect(io.erreurs).toEqual([]);
      rienCree(repo);
    });
  }

  for (const args of [['--zorglub'], ['--taile', 'fonction', 'Crée x'], ['- corrige x'], ['--fond', '--aide']]) {
    it(`${JSON.stringify(args)} : refusé en code 2, rien créé`, async () => {
      const repo = depot(), io = { ...ioTest(), cwd: repo };
      expect(await run(['run', ...args], io)).toBe(2);
      expect(io.erreurs[0]).toMatch(/option inconnue : -/);
      expect(io.erreurs[0]).toMatch(/cadence run "<demande>"/);
      rienCree(repo);
    });
  }

  // L699 : le modèle se choisit par --modele ou CADENCE_RUN_MODELE ; une valeur inconnue ne crée rien, avec ou sans --fond
  const refus: [string, string[], NodeJS.ProcessEnv, RegExp][] = [
    ['option inconnue', ['--modele', 'gpt', 'Crée x'], {}, /modèle inconnu : « gpt » ; attendu : opus, fable$/],
    ['sonnet refusé (cause C2)', ['--modele', 'sonnet', 'Crée x'], {}, /modèle inconnu : « sonnet »/],
    ['haiku refusé par la variable', ['Crée x'], { CADENCE_RUN_MODELE: 'haiku' }, /modèle inconnu : « haiku » \(CADENCE_RUN_MODELE\)/],
    ['option sans valeur', ['Crée x', '--modele'], {}, /modèle inconnu : «\s+»/],
    ['option inconnue avec --fond', ['--fond', '--modele', 'gpt', 'Crée x'], {}, /modèle inconnu : « gpt »/],
    ['variable lue', ['Crée x'], { CADENCE_RUN_MODELE: 'gpt' }, /modèle inconnu : « gpt » \(CADENCE_RUN_MODELE\)/],
    ['variable lue avec --fond', ['--fond', 'Crée x'], { CADENCE_RUN_MODELE: 'gpt' }, /modèle inconnu : « gpt » \(CADENCE_RUN_MODELE\)/],
    ['l\'option l\'emporte sur la variable', ['--modele', 'gpt', 'Crée x'], { CADENCE_RUN_MODELE: 'fable' }, /modèle inconnu : « gpt » ;/],
  ];
  for (const [nom, args, env, message] of refus) {
    it(`modèle, ${nom} : refusé en code 2, rien créé`, async () => {
      const repo = depot(), io = { ...ioTest(env), cwd: repo };
      expect(await run(['run', ...args], io)).toBe(2);
      expect(io.erreurs[0]).toMatch(message);
      expect(io.sortie).toEqual([]);
      rienCree(repo);
    });
  }

  // Lancement réel par la CLI, avec un faux claude qui commite : le modèle de la commande est celui de la variable, sauf option
  const lances: [string, string[], NodeJS.ProcessEnv, string][] = [
    ['variable valide prise en compte', ['--sans-porte', 'Crée x'], { CADENCE_RUN_MODELE: 'fable' }, 'fable'],
    ['l\'option valide l\'emporte sur la variable', ['--sans-porte', '--modele', 'opus', 'Crée x'], { CADENCE_RUN_MODELE: 'fable' }, 'opus'],
    ['ni option ni variable', ['--sans-porte', 'Crée x'], {}, 'opus'],
  ];
  for (const [nom, args, env, attendu] of lances) {
    it(`modèle, ${nom} : la commande claude part en ${attendu}, la ligne de lancement le dit`, async () => {
      const repo = depot(), io = { ...ioTest(env), cwd: repo }, appels: string[][] = [];
      const code = await cmdRun(args, io, (a, o) => {
        appels.push(a); writeFileSync(join(o.cwd, 'x.txt'), 'x');
        git(o.cwd, 'add', 'x.txt'); git(o.cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
        return { stdout: JSON.stringify({ session_id: 's1', total_cost_usd: 0, result: 'fini', subtype: 'success' }), code: 0 };
      });
      expect([code, io.erreurs]).toEqual([0, []]);
      expect(appels).toHaveLength(1);
      expect(appels[0][appels[0].indexOf('--model') + 1]).toBe(attendu);
      expect(io.sortie[0]).toMatch(new RegExp(`session ${attendu[0].toUpperCase()}${attendu.slice(1)} en mode leger `));
    });
  }

  it('l\'usage cite --modele, ses deux valeurs et la variable', async () => {
    const io = ioTest();
    expect(await run(['run', '--help'], io)).toBe(0);
    expect(io.sortie.join('\n')).toMatch(/\[--modele opus\|fable\][\s\S]*CADENCE_RUN_MODELE/);
  });
});
