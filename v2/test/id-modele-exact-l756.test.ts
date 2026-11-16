// L756 (veille, issue #61) : chaque mesure du banc et chaque run notent l'identifiant exact du modèle (claude-fable-5-2, pas « fable ») : depuis
// Claude Code 2.1.321 (09-11), l'alias fable a changé sous nos pieds. L'id vient de ce que la session a réellement utilisé (sa sortie), jamais
// de l'alias demandé à --model. L742 l'a mis dans l'en-tête des rapports de bras ; restaient la ligne d'historique (que lit la garde), les juges
// et cadence run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import type { Executeur } from '../src/bench/bras.js';
import { passage } from '../src/bench/cli.js';
import { ajouterSession, claudeVide, ecartsEnvironnement, enteteEnvironnement, environnement, modelesExacts } from '../src/bench/environnement.js';
import { juger } from '../src/bench/juges.js';
import { executerRun, type Etat } from '../src/run/run.js';
import type { MesureEtape, ResultatSequence } from '../src/sequence/passage.js';
import { conclureSequence } from '../src/sequence/verdict.js';
import { commite, depot, io } from './run-outils.js';
import { dossierTemp } from './temp.js';

/** Ce que l'alias résout aujourd'hui : l'id que dit la session, distinct de l'alias passé à --model. */
const ID: Record<string, string> = { opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' };
/** Le flux stream-json d'une session : init (modèle exact), puis le result. `quota` : le result d'une fin de limite (D-15). */
const flux = (session: string, modele: string, quota?: string) => [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: modele, claude_code_version: '2.1.325' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: !!quota, result: quota ?? 'fini', session_id: session, total_cost_usd: 0.1,
    modelUsage: { [modele]: { inputTokens: 1, contextWindow: 1_000_000 } } }),
].join('\n');
const alias = (args: string[]) => args[args.indexOf('--model') + 1];

describe('cadence run : chaque passe note l\'id exact de sa session', () => {
  let t = Date.parse('2026-11-16T08:00:00Z');
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime((t += 60_000)); });
  afterEach(() => { vi.useRealTimers(); });
  const relire = (e: Etat) => JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;

  it('l\'id vient de la sortie de la session, pas de l\'alias : dans l\'état et dans la ligne « modèles : » de fin', () => {
    const repo = depot(), { l, out } = io();
    const exec: Executeur = (args, o) => { commite('fait.txt')(o.cwd); return { stdout: flux('s1', 'claude-opus-5-6-preview'), code: 0 }; }; // l'alias a bougé
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out });
    expect(relire(e).passes).toEqual([{ quoi: 'travail', modele: 'opus', raison: 'par défaut', id_modele: 'claude-opus-5-6-preview' }]);
    expect(l).toContain('modèles : travail : Opus (par défaut) → claude-opus-5-6-preview');
  });

  it('bascule sur fable à la limite Opus : chaque passe garde l\'id de SA session', () => {
    const repo = depot(), { l, out } = io();
    let n = 0;
    const exec: Executeur = (args, o) => {
      if (n++ === 0) return { stdout: flux('s1', ID[alias(args)], "You've hit your Opus limit · resets Fri 10am (Europe/Paris)"), code: 1 };
      commite('fait.txt')(o.cwd); return { stdout: flux('s1', ID[alias(args)]), code: 0 };
    };
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out });
    expect(relire(e).passes?.map((p) => [p.modele, p.id_modele])).toEqual([['opus', 'claude-opus-5-5'], ['fable', 'claude-fable-5-2']]);
    expect(l).toContain('modèles : travail : Opus (par défaut) → claude-opus-5-5 · reprise : Fable (limite Opus atteinte) → claude-fable-5-2');
  });

  it('une sortie sans system/init : « id non lu », jamais l\'alias présenté comme un id', () => {
    const repo = depot(), { l, out } = io();
    const exec: Executeur = (_a, o) => { commite('fait.txt')(o.cwd); return { stdout: JSON.stringify({ session_id: 's1', total_cost_usd: 0, result: 'fini', subtype: 'success' }), code: 0 }; };
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out });
    expect(relire(e).passes?.[0].id_modele).toBeUndefined();
    expect(l).toContain('modèles : travail : Opus (par défaut) → id non lu');
  });
});

describe('banc : la ligne d\'historique porte l\'id exact de chaque bras', () => {
  const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  it('passage mécanique : modeles_exacts lus dans les sessions, à côté de l\'alias modele_candidat', async () => {
    const r = dossierTemp('bench-l756-');
    mkdirSync(join(r, 'bancs', '1-a'), { recursive: true }); mkdirSync(join(r, 'secrets', '1-a'), { recursive: true });
    writeFileSync(join(r, 'bancs', '1-a', 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
    writeFileSync(join(r, 'bancs', '1-a', 'demande.md'), 'd');
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\nF:\n  modele: fable\n  brief: ${BRIEF}\n`);
    const prep = (_b: unknown, cible: string) => {
      mkdirSync(cible, { recursive: true });
      execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
      return { testsBase: 0 };
    };
    const exec: Executeur = (args, o) => {
      writeFileSync(join(o.cwd, 'f.ts'), 'x');
      execFileSync('bash', ['-c', 'git add -A && git -c user.email=t@t -c user.name=t commit -q -m bras'], { cwd: o.cwd });
      return { stdout: flux('s', ID[alias(args)]), code: 0 };
    };
    await passage({ racine: r, ref: 'A', cand: 'F', hebdo: false, juge: 'opus', niveau: 'mecanique', exec, prep: prep as never, maintenant: new Date('2026-11-16T09:00:00Z'),
      empreinte: 'e1', home: r, out: () => {}, version: () => '2.1.325' });
    const h = JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim());
    expect(h).toMatchObject({ modele_candidat: 'fable', modeles_exacts: { A: ['claude-opus-5-5'], F: ['claude-fable-5-2'] } });
    expect(h.modeles_exacts.juges).toBeUndefined(); // mécanique : aucun juge
  });

  it('séquence : la ligne d\'historique et l\'en-tête portent les id des bras et des juges', () => {
    const r = dossierTemp('seq-l756-');
    const etape = (b: string): MesureEtape => ({ k: 1, portee_suite: 'tout', fuites: [], fuites_a_verifier: [], suite_en_erreur: null, mesure_en_erreur: null,
      mesure: { bras: 'c1', banc: 's', debut: '', fin: '', duree_s: 1, tokens: 1, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null,
        claude: ajouterSession(claudeVide(), flux('s', b === 'A' ? ID.opus : ID.fable)) } });
    const jugement = { meca: {}, defauts: {}, prefere: 'egal', ui: 'na', raisons: '', modeles_juge: ['claude-opus-5-5'] };
    const s: ResultatSequence = { run: '2026-11-16-1000-e1', sequence: 'q', clones: {}, base: {}, etapes: { A: [etape('A')], F: [etape('F')] }, jugement };
    conclureSequence(r, s, 'A', 'F', { maintenant: new Date('2026-11-16T09:00:00Z'), empreinte: 'e1', modele_candidat: 'fable', alias: { A: 'opus', F: 'fable' }, version: '2.1.325', juge: 'opus' });
    const h = JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim());
    expect(h.modeles_exacts).toEqual({ A: ['claude-opus-5-5'], F: ['claude-fable-5-2'], juges: ['claude-opus-5-5'] });
    expect(readFileSync(join(r, 'rapports', '2026-11-16-1000-e1-q-r1.md'), 'utf8').split('\n')).toContain('Juges : alias opus → claude-opus-5-5');
  });
});

describe('juges : l\'id exact des modèles qu\'ils ont facturés', () => {
  it('juger() rend modeles_juge lu dans modelUsage de chaque session, sans doublon', () => {
    const r = dossierTemp('juges-l756-');
    const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'demande.md'), 'd');
    const secrets = join(r, 'secrets', '1-t'); mkdirSync(secrets, { recursive: true }); writeFileSync(join(secrets, 'mesure.md'), 'm');
    const A = join(r, 'runs', 'A'), cand = join(r, 'runs', 'cand'); mkdirSync(A, { recursive: true });
    execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: A });
    execFileSync('git', ['clone', '-q', A, cand]);
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: A, encoding: 'utf8' }).trim();
    const b: Banc = { id: '1-t', dir, secrets, projet: 't', source: '/s', base, install: 'true', tests: 'true', visible: false, taille: 'retouche', frais: false, reponses: false };
    const meca = { suite_ok: true, caches_passes: 1, caches_total: 1, mutations_tuees: 1, mutations_total: 1, attendu: 'oui', mutations: [] };
    const avis = { X: { bloquants: 0, majeurs: 0, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 0 }, prefere: 'egal', ui: 'na', raisons: 'r' };
    const sorties = [{ X: meca, Y: meca, remplaces: [] }, avis, avis];
    let i = 0;
    const exec: Executeur = (args) => {
      writeFileSync(/dans (\S+\.json)/.exec(args[args.indexOf('-p') + 1])![1], JSON.stringify(sorties[i++]));
      const usage = i === 2 ? { 'claude-opus-5-5': {}, 'claude-haiku-5-5': {} } : { 'claude-opus-5-5': {} };
      return { stdout: JSON.stringify({ session_id: `j${i}`, total_cost_usd: 0, modelUsage: usage }), code: 0 };
    };
    const j = juger(b, { A, cand }, join(r, 'eval'), 'opus', exec, () => 0.2);
    expect(j!.modeles_juge).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
  });

  it('l\'environnement porte les juges ; l\'en-tête et la comparaison les disent', () => {
    const avant = environnement('2.1.325', { A: 'opus' }, [], { alias: 'opus', jugements: [{ modeles_juge: ['claude-opus-5-5'] }] });
    const apres = environnement('2.1.325', { A: 'opus' }, [], { alias: 'opus', jugements: [null, { modeles_juge: ['claude-opus-5-6'] }] });
    expect(enteteEnvironnement(apres, null)).toContain('Juges : alias opus → claude-opus-5-6');
    expect(ecartsEnvironnement(avant, apres)).toEqual(['juges (alias opus) : claude-opus-5-5 → claude-opus-5-6']);
    expect(modelesExacts(apres)).toEqual({ juges: ['claude-opus-5-6'] });
    expect(environnement('2.1.325', {}, [], { alias: 'opus', jugements: [null] }).juges).toBeUndefined(); // aucun jugement : rien n'est affirmé
    expect(enteteEnvironnement(environnement('2.1.325', {}, [], { alias: 'opus', jugements: [{}] }), null)).toContain('Juges : alias opus → non lu (aucune session de juge n\'a rendu de modelUsage)');
  });
});
