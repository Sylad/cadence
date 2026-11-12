// L705 (D-7) : coupes du socle d'une session de cadence run. C2 (plugins sauf cadence et playwright), C3 (connecteurs claude.ai) et C4 (mémoire auto)
// passent par le --settings de chaque session du run ; C1 (worktree hors du dépôt) est l'option run.worktreeOutside du dépôt. Le banc ne change pas.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { argsClaude } from '../src/bench/bras.js';
import { BRAS_COMPLET, BRAS_LEGER } from '../src/run/aiguillage.js';
import { executerRun } from '../src/run/run.js';
import { reglagesRun } from '../src/socle.js';
import { commite, depot, fauxClaude, git } from './run-outils.js';
import { dossierTemp } from './temp.js';

const PLUGINS = { 'superpowers@claude-plugins-official': true, 'feature-dev@claude-plugins-official': true, 'cadence@cadence': true,
  'playwright@claude-plugins-official': true, 'context7@claude-plugins-official': false };
const reglagesLus = (args: string[]) => JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')) as Record<string, unknown>;

describe('L705 : coupes du socle de cadence run', () => {
  const avant = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CADENCE_HOME: process.env.CADENCE_HOME };
  beforeEach(() => {
    const home = dossierTemp('claude-home-');
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: PLUGINS, language: 'Français' }));
    process.env.CLAUDE_CONFIG_DIR = home; process.env.CADENCE_HOME = dossierTemp('cadence-home-');
  });
  afterEach(() => { for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  it('C2, C3, C4 : chaque session du run reçoit les plugins actifs à false sauf cadence et playwright, les connecteurs claude.ai et la mémoire auto coupés', () => {
    const repo = depot(), vus: Record<string, unknown>[] = [];
    mkdirSync(join(repo, '.claude')); writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'qodo@claude-plugins-official': true } }));
    git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'projet');
    const exec = fauxClaude([(cwd, a) => { vus.push(reglagesLus(a)); commite('autre.txt')(cwd); }, (cwd, a) => { vus.push(reglagesLus(a)); commite('fait.txt')(cwd); }]);
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    expect(e.mode).toBe('leger');
    expect(vus).toHaveLength(2); // la reprise après une porte rouge aussi
    for (const r of vus) expect(r).toEqual({
      enabledPlugins: { 'superpowers@claude-plugins-official': false, 'feature-dev@claude-plugins-official': false, 'qodo@claude-plugins-official': false },
      disableClaudeAiConnectors: true, autoMemoryEnabled: false });
  });

  it('mode complet : les coupes s\'ajoutent au hook de lecture du bras, qui reste', () => {
    const repo = depot();
    let r: Record<string, unknown> = {};
    const e = executerRun({ repo, demande: 'Crée fait.txt', complet: true, exec: fauxClaude([(cwd, a) => { r = reglagesLus(a); commite('fait.txt')(cwd); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(JSON.stringify(r.hooks)).toMatch(/lecture-obligatoire\.mjs/);
    expect(r).toMatchObject({ disableClaudeAiConnectors: true, autoMemoryEnabled: false, enabledPlugins: { 'superpowers@claude-plugins-official': false } });
  });

  it('sans plugin activé, pas de enabledPlugins ; C3 et C4 restent', () => {
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), '{}');
    expect(reglagesRun(dossierTemp('wt-'))).toEqual({ disableClaudeAiConnectors: true, autoMemoryEnabled: false });
  });

  it('le banc garde ses réglages : argsClaude sans supplément ne passe aucun --settings en léger, le fichier du bras tel quel en complet', () => {
    const clone = join(dossierTemp('banc-'), 'clone'); // ses réglages vont à côté : dans le dossier temporaire
    expect(argsClaude(BRAS_LEGER, clone)).not.toContain('--settings');
    const a = argsClaude(BRAS_COMPLET, clone), texte = readFileSync(a[a.indexOf('--settings') + 1], 'utf8');
    expect(texte).toBe(readFileSync(BRAS_COMPLET.settings!, 'utf8').replaceAll('{{HOOKS}}', join(dirname(BRAS_COMPLET.settings!), '..', 'hooks')));
    expect(texte).not.toMatch(/disableClaudeAiConnectors|autoMemoryEnabled|enabledPlugins/);
  });

  it('C1 désactivée par défaut : le worktree est à côté du dépôt, sous ../.cadence-run, où Claude Code charge le CLAUDE.md parent', () => {
    const repo = depot();
    let cwd = '';
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(c) => { cwd = c; commite('fait.txt')(c); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(cwd).toBe(join(dirname(repo), '.cadence-run', `projet-${e.id}`));
  });

  it('C1 : run.worktreeOutside: true met le worktree sous CADENCE_HOME/run-worktrees ; l\'état reste à côté du dépôt, intégration comme avant', () => {
    const repo = depot();
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  test: test -f fait.txt\nrun:\n  worktreeOutside: true\n');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'c1');
    let cwd = '';
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(c) => { cwd = c; commite('fait.txt')(c); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(cwd).toBe(join(process.env.CADENCE_HOME!, 'run-worktrees', `projet-${e.id}`));
    expect(e.fichier).toBe(join(dirname(repo), '.cadence-run', `projet-${e.id}.json`));
    expect(existsSync(cwd)).toBe(false); // retiré à l'intégration
    expect(git(repo, 'log', '--oneline', '-1')).toMatch(/ajoute fait.txt/);
  });

  it('C1 : une valeur qui n\'est pas un booléen est refusée avant toute création', () => {
    const repo = depot();
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  test: "true"\nrun:\n  worktreeOutside: oui\n');
    expect(() => executerRun({ repo, demande: 'x', exec: fauxClaude([]), out: () => {} })).toThrow(/run\.worktreeOutside : true ou false attendu/);
    expect(existsSync(join(dirname(repo), '.cadence-run')) ? readdirSync(join(dirname(repo), '.cadence-run')) : []).toEqual([]);
    expect(git(repo, 'branch', '--list', 'cadence/*')).toBe('');
  });
});
