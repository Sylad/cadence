import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS_DIR, SKILLS_DIR } from '../src/skills.js';

const flat = (text: string): string => text.replace(/\s+/g, ' ');
const agent = flat(readFileSync(join(AGENTS_DIR, 'qa-reviewer.md'), 'utf8'));
const lead = flat(readFileSync(join(SKILLS_DIR, 'lead', 'SKILL.md'), 'utf8'));

describe('probe L511 — profil de navigateur isolé du qa-reviewer', () => {
  it('le profil suffixé du pid est retiré en fin de passe (sinon il s\'accumule ; seul le profil nommé est conservé)', () => {
    const tail = agent.slice(agent.indexOf('except the QA browser profile'));
    expect(tail).toMatch(/suffixed[^.]*(remove|delete|discard)|(remove|delete)[^.]*suffixed/i);
  });

  it('la clause « conservé pour la prochaine passe » ne vise que le profil nommé d\'après l\'app, pas le suffixé', () => {
    const clause = agent.slice(agent.indexOf('except the QA browser profile'), agent.indexOf('except the QA browser profile') + 160);
    expect(clause).not.toMatch(/^except the QA browser profile, which is kept for the next pass\. The working/);
  });

  it('un profil en cours d\'usage dont le SingletonLock est périmé (crash) est traité : le texte dit comment le distinguer d\'un profil réellement ouvert', () => {
    expect(agent).toMatch(/SingletonLock[^.]*pid[^.]*no longer running[^.]*remove/i);
  });

  it('le profil nommé est tenté d\'abord ; le suffixé n\'est pris que si le lancement échoue parce qu\'il est ouvert (pas de test-puis-lancer)', () => {
    expect(agent).toMatch(/launch (it|the named[^.]*) first[^.]*fails[^.]*(open|in use)[^.]*suffixed/i);
    expect(agent).not.toMatch(/when that directory is already open in another browser \(a `SingletonLock` file in it\)/);
  });

  it('le nom du profil est un nom de dossier sûr (":" du port neutralisé)', () => {
    expect(agent).toMatch(/host and port[^)]*\)[^.]*(replace|sanitiz|safe|-|_)/i);
  });

  it('le profil est dit hors du dépôt avec un emplacement précis (pas seulement « outside the repository »)', () => {
    expect(agent).toMatch(/userDataDir[^.]*(\/tmp|tmpdir|cache|\$HOME|~\/|home)/i);
  });

  it('l\'outil MCP playwright ne prend pas userDataDir : le texte nomme le moyen (script Bash/launchPersistentContext) de lancer le contexte persistant', () => {
    expect(agent).toMatch(/do not use them/i);
    expect(agent).toMatch(/launchPersistentContext[^.]*Bash|Bash[^.]*launchPersistentContext/i);
  });

  it('le skill lead ne contient plus « one at a time » / « une QA à la fois » pour la QA', () => {
    expect(lead).not.toMatch(/qa-reviewer[^.]*(one at a time|only one)/i);
    expect(lead).not.toMatch(/une QA à la fois/i);
  });

  it('une seule occurrence de la règle d\'isolation dans l\'étape 4 (pas de doublon sur répétition)', () => {
    expect(agent.split('The browser is yours alone').length - 1).toBe(1);
    expect(agent.split('At the end, close your own context').length - 1).toBe(1);
  });
});
