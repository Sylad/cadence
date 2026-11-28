// L936 (D-45, piste 1) : le socle d'une session de cadence run ne garde de la configuration de l'utilisateur que ce qui sert à un run. Coupés par
// défaut : CLAUDE.md des dossiers au-dessus du dépôt, agents et skills de l'utilisateur et des plugins gardés, serveurs MCP de l'utilisateur, outils
// intégrés du lead ; `run.session` du cadence.yaml en garde ce que le projet nomme. Mesure : docs/mesures/socle-run-2026-11-28.md. Le banc ne change pas.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lireRegeneration, lireSessionRun } from '../../scripts/regeneration.mjs';
import { argsClaude, OUTILS_INTERDITS } from '../src/bench/bras.js';
import { BRAS_LEGER } from '../src/run/aiguillage.js';
import { executerRun } from '../src/run/run.js';
import { coupesSession, OUTILS_DU_LEAD, reglagesRun } from '../src/socle.js';
import { commite, depot, fauxClaude } from './run-outils.js';
import { dossierTemp } from './temp.js';

const ecrire = (f: string, t: string) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); };
const agent = (nom: string) => `---\nname: ${nom}\ndescription: agent ${nom}\n---\nCorps qui cite name: autre\n`;
const skill = (nom: string) => `---\nname: ${nom}\ndescription: skill ${nom}\n---\n`;
const reglagesLus = (args: string[]) => JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')) as Record<string, unknown>;

/** Un dossier de configuration de Claude Code : CLAUDE.md, deux agents, trois skills, deux serveurs MCP, le plugin cadence (un agent, un skill) et superpowers. */
function configuration(): string {
  const conf = dossierTemp('claude-conf-'), plugin = dossierTemp('plugin-cadence-');
  ecrire(join(conf, 'CLAUDE.md'), 'Règles de l\'utilisateur : pour un écran, charge le skill `interface-utilisable`.\n');
  ecrire(join(conf, 'agents', 'expert-cartes.md'), agent('expert-cartes'));
  ecrire(join(conf, 'agents', 'fichier-sans-nom.md'), 'Pas d\'en-tête.\n');
  for (const s of ['interface-utilisable', 'reprise', 'deploiement']) ecrire(join(conf, 'skills', s, 'SKILL.md'), skill(s));
  ecrire(join(conf, '.claude.json'), JSON.stringify({ mcpServers: { docs: {}, nuage: {} } }));
  ecrire(join(plugin, 'agents', 'code-reviewer.md'), agent('code-reviewer'));
  ecrire(join(plugin, 'skills', 'lead', 'SKILL.md'), skill('lead'));
  ecrire(join(conf, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'cadence@cadence': [{ scope: 'user', installPath: plugin }] } }));
  ecrire(join(conf, 'settings.json'), JSON.stringify({ enabledPlugins: { 'cadence@cadence': true, 'superpowers@claude-plugins-official': true } }));
  return conf;
}

/** Un worktree sous un dossier parent qui a son CLAUDE.md (le dossier du lead), avec un cadence.yaml optionnel. */
function worktree(yaml?: string): { wt: string; parent: string } {
  const parent = dossierTemp('dossier-lead-'), wt = join(parent, '.cadence-run', 'projet-1');
  ecrire(join(parent, 'CLAUDE.md'), 'Consignes du lead : skill `reprise` en début de session.\n');
  ecrire(join(wt, 'CLAUDE.md'), 'Règles du projet.\n');
  if (yaml) ecrire(join(wt, 'cadence.yaml'), yaml);
  return { wt, parent: join(parent, 'CLAUDE.md') };
}

describe('L936 : socle allégé de cadence run', () => {
  const avant = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CADENCE_HOME: process.env.CADENCE_HOME };
  let conf = '';
  beforeEach(() => { conf = configuration(); process.env.CLAUDE_CONFIG_DIR = conf; process.env.CADENCE_HOME = dossierTemp('cadence-home-'); });
  afterEach(() => { for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  it('par défaut : CLAUDE.md parent exclu, agents de l\'utilisateur et du plugin gardé refusés, skills non cités coupés, serveurs MCP de l\'utilisateur refusés', () => {
    const { wt, parent } = worktree();
    const r = reglagesRun(wt, process.env, undefined, 'Demande : déploie avec le skill deploiement.');
    expect(r.claudeMdExcludes).toEqual([parent]); // celui de l'utilisateur et celui du projet restent
    expect(r.permissions).toEqual({ deny: ['Agent(expert-cartes)', 'Agent(fichier-sans-nom)', 'Agent(cadence:code-reviewer)'] }); // superpowers est coupé (C2) : rien de lui
    // interface-utilisable : cité par le CLAUDE.md de l'utilisateur, gardé ; deploiement : cité par la demande ; reprise : cité par le seul CLAUDE.md parent, exclu
    expect(r.skillOverrides).toEqual({ reprise: 'off' });
    expect(r.deniedMcpServers).toEqual([{ serverName: 'docs' }, { serverName: 'nuage' }]);
    expect(r).toMatchObject({ enabledPlugins: { 'superpowers@claude-plugins-official': false }, disableClaudeAiConnectors: true, autoMemoryEnabled: false });
  });

  it('run.session garde ce que le projet nomme : CLAUDE.md parent, agents, skills, serveurs MCP ; userClaudeMd: false exclut celui de l\'utilisateur', () => {
    const { wt } = worktree('run:\n  session:\n    parentClaudeMd: true\n    userClaudeMd: false\n    keepAgents: [expert-cartes, cadence:code-reviewer]\n    keepSkills: [deploiement]\n    keepMcpServers: [docs]\n');
    const r = coupesSession(wt, process.env, ['cadence@cadence']);
    expect(r.claudeMdExcludes).toEqual([join(conf, 'CLAUDE.md')]);
    expect(r.permissions).toEqual({ deny: ['Agent(fichier-sans-nom)'] });
    // le CLAUDE.md parent, gardé, cite reprise ; celui de l'utilisateur, exclu, ne garde plus interface-utilisable
    expect(r.skillOverrides).toEqual({ 'interface-utilisable': 'off' });
    expect(r.deniedMcpServers).toEqual([{ serverName: 'nuage' }]);
  });

  it('rien à couper : aucune clé ajoutée (configuration vide, aucun CLAUDE.md au-dessus)', () => {
    process.env.CLAUDE_CONFIG_DIR = dossierTemp('claude-vide-');
    expect(coupesSession(dossierTemp('wt-'), process.env, [])).toEqual({});
  });

  it('un nom cité se lit comme un mot : « reprise-x » ou « cadence:reprise » ne gardent pas le skill reprise', () => {
    const { wt } = worktree('run:\n  session:\n    parentClaudeMd: true\n');
    writeFileSync(join(dirname(dirname(wt)), 'CLAUDE.md'), 'Voir reprise-x et cadence:reprise.\n');
    expect(coupesSession(wt, process.env, []).skillOverrides).toMatchObject({ reprise: 'off' });
  });

  it('dans un vrai run : chaque session reçoit les coupes et les outils du lead dans --disallowedTools, les mêmes à la reprise', () => {
    const repo = depot(), vus: string[][] = [], lus: Record<string, unknown>[] = [];
    ecrire(join(dirname(repo), 'CLAUDE.md'), 'Consignes du lead.\n');
    const exec = fauxClaude([(cwd, a) => { vus.push(a); lus.push(reglagesLus(a)); commite('autre.txt')(cwd); }, (cwd, a) => { vus.push(a); lus.push(reglagesLus(a)); commite('fait.txt')(cwd); }]);
    const e = executerRun({ repo, demande: 'Crée fait.txt avec le skill reprise', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    expect(vus).toHaveLength(2);
    for (const [i, a] of vus.entries()) {
      const interdits = a[a.indexOf('--disallowedTools') + 1].split(',');
      for (const o of OUTILS_DU_LEAD) expect(interdits).toContain(o);
      for (const o of ['Bash', 'Read', 'Edit', 'Write', 'Agent', 'Task', 'Skill', 'ToolSearch']) expect(interdits).not.toContain(o);
      const r = lus[i];
      expect(r.claudeMdExcludes).toEqual([join(dirname(repo), 'CLAUDE.md')]);
      expect(r.skillOverrides).toEqual({ deploiement: 'off' }); // reprise : cité par la demande
    }
    expect(lus[0]).toEqual(lus[1]);
  });

  it('cadence.yaml : run.session mal formé refusé par la lecture du run et par la validation de cadence.yaml, en nommant la clé', () => {
    for (const [session, attendu] of [
      [{ parentClaudeMd: 'oui' }, 'run.session.parentClaudeMd : true ou false attendu (reçu « oui »)'],
      [{ keepAgents: 'expert' }, 'run.session.keepAgents : liste de noms attendue'],
      [{ keepSkills: [''] }, 'run.session.keepSkills : liste de noms attendue'],
      [{ garder: [] }, 'run.session.garder inconnu (attendu : parentClaudeMd, userClaudeMd, keepAgents, keepSkills, keepMcpServers)'],
      [[], 'run.session doit être un objet'],
    ] as const) {
      expect(() => lireSessionRun({ session }, 'cadence.yaml')).toThrow(`cadence.yaml : ${attendu}`);
      expect(() => lireRegeneration({ session }, 'cadence.yaml')).toThrow(`cadence.yaml : ${attendu}`);
    }
    expect(lireSessionRun(undefined, 'f')).toEqual({ parentClaudeMd: false, userClaudeMd: true, keepAgents: [], keepSkills: [], keepMcpServers: [] });
  });

  it('revue M1 : un serveur MCP de navigateur de l\'utilisateur (claude mcp add playwright) reste par défaut, les autres sont refusés', () => {
    ecrire(join(conf, '.claude.json'), JSON.stringify({ mcpServers: { playwright: {}, 'chrome-devtools': {}, docs: {} } }));
    expect(coupesSession(worktree().wt, process.env, []).deniedMcpServers).toEqual([{ serverName: 'docs' }]);
  });

  it('revue m3 : run.session mal formé refusé avant toute création (ni worktree, ni branche, ni session)', () => {
    const repo = depot();
    writeFileSync(join(repo, 'cadence.yaml'), 'run:\n  session:\n    keepSkills: oui\n');
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'run.session mal formé'], { stdio: 'ignore' });
    let appels = 0;
    const exec = fauxClaude([() => { appels++; }]);
    expect(() => executerRun({ repo, demande: 'x', exec, out: () => {} })).toThrow('cadence.yaml : run.session.keepSkills : liste de noms attendue');
    expect(appels).toBe(0);
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', 'cadence/run-*'], { encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  });

  it('le banc ne change pas : ni outil du lead interdit, ni réglage du socle pour un bras', () => {
    for (const o of OUTILS_DU_LEAD) expect(OUTILS_INTERDITS).not.toContain(o);
    const a = argsClaude(BRAS_LEGER, join(dossierTemp('banc-'), 'clone'));
    expect(a).not.toContain('--settings');
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe(OUTILS_INTERDITS.join(','));
  });
});
