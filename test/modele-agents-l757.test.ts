import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { buildArgs, readAgents } from '../src/orchestrate/launch.js';
import { installAgents } from '../src/skills.js';
import { collecter, estRatee, jetonsParModele, main, nomCourt, reponseDe } from '../scripts/jetons-agents.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

// L757 (D-4) : les agents mécaniques ont un modèle explicite, les juges héritent encore du modèle de la session (Opus) tant que la mesure
// n'a pas parlé ; le modèle d'une étape d'orchestrate reste celui de son --model ; scripts/jetons-agents.mjs lit les jetons par livraison.
const root = join(import.meta.dirname, '..');
const frontmatter = (f: string) => parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(join(root, 'agents', f), 'utf8'))![1]) as Record<string, unknown>;
const MECANIQUES: Record<string, string> = { 'livreur.md': 'sonnet', 'precheck-reader.md': 'sonnet' };

describe('L757 — modèle des agents du plugin', () => {
  it('livreur et precheck-reader déclarent sonnet ; les autres, juges compris, ne déclarent aucun modèle (ils héritent)', () => {
    const agents = readdirSync(join(root, 'agents')).filter((f) => f.endsWith('.md'));
    expect(agents).toContain('code-reviewer.md');
    for (const f of agents) expect([f, frontmatter(f).model]).toEqual([f, MECANIQUES[f]]);
  });

  it('cadence skills install recopie le modèle de l\'agent', () => {
    const dest = tempDir();
    installAgents(join(root, 'agents'), dest, false);
    expect(readFileSync(join(dest, 'cadence-livreur.md'), 'utf8')).toMatch(/^model: sonnet$/m);
  });

  it('une étape d\'orchestrate garde son --model : la définition passée à --agents ne porte pas de modèle', () => {
    const agents = readAgents(join(root, 'agents'));
    const spec = { kind: 'precheck', brief: 'b', schema: {}, model: 'sonnet', agent: 'precheck-reader', sessionId: 's', permissionMode: 'auto', addDirs: [] } as unknown as Parameters<typeof buildArgs>[0];
    const args = buildArgs(spec, agents);
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(JSON.parse(args[args.indexOf('--agents') + 1])['precheck-reader']).not.toHaveProperty('model');
  });
});

const ts = (m: number) => new Date(Date.UTC(2026, 10, 16, 12, m)).toISOString();
const appelAgent = (m: number, type: string, prompt: string) => JSON.stringify({ type: 'assistant', timestamp: ts(m), message: { id: `p${m}`, model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: `t${m}`, name: 'Agent', input: { subagent_type: type, prompt } }] } });
const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const reponse = (id: string, model: string, usage: object, content: unknown[]) => JSON.stringify({ type: 'assistant', message: { id, model, usage, content } });
const U = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };

/** Une session du lead : deux livraisons (Opus, puis Sonnet ratée), un code-reviewer et un sous-agent sans appel connu. */
function projets(): string {
  const p = tempDir(), d = join(p, '-home-x-projet'), sous = join(d, 'sess1', 'subagents');
  mkdirSync(sous, { recursive: true });
  writeFileSync(join(d, 'sess1.jsonl'), [appelAgent(1, 'cadence:livreur', 'Livre L84 au sha abc'), appelAgent(2, 'cadence:code-reviewer', 'Revue L84'), appelAgent(3, 'cadence-livreur', 'Livre L85 au sha def')].join('\n'));
  writeFileSync(join(sous, 'agent-a.jsonl'), [user('Livre L84 au sha abc'),
    reponse('m1', 'claude-opus-5-5', U, [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }]),
    reponse('m1', 'claude-opus-5-5', U, [{ type: 'text', text: 'je lance la porte' }]), // même message.id : compté une fois
    user([{ type: 'tool_result', tool_use_id: 'b' }]),
    reponse('m2', 'claude-opus-5-5', U, [{ type: 'text', text: '\nL84 livré abc1234, QA à lancer http://x' }])].join('\n'));
  writeFileSync(join(sous, 'agent-b.jsonl'), [user('Revue L84'), reponse('r1', 'claude-opus-5-5', U, [{ type: 'text', text: 'Verdict: conforme' }])].join('\n'));
  writeFileSync(join(sous, 'agent-c.jsonl'), [user([{ type: 'text', text: 'Livre L85 au sha def' }]), reponse('s1', 'claude-sonnet-5-5', U, [{ type: 'text', text: 'Question : la porte est rouge' }])].join('\n'));
  writeFileSync(join(sous, 'agent-d.jsonl'), [user('autre chose'), reponse('z1', 'claude-opus-5-5', U, [{ type: 'text', text: 'L1 livré' }])].join('\n'));
  return p;
}

describe('L757 — scripts/jetons-agents.mjs, la mesure par livraison', () => {
  it('compte une fois un message.id répété, par modèle, cache compris', () => {
    const t = [reponse('m1', 'claude-opus-5-5', U, []), reponse('m1', 'claude-opus-5-5', U, []), reponse('m2', 'claude-sonnet-5-5', U, [])].join('\n');
    expect(jetonsParModele(t)).toEqual({ 'claude-opus-5-5': 1115, 'claude-sonnet-5-5': 1115 });
  });

  it('relie chaque sous-agent à son appel par le prompt, ne garde que l\'agent demandé', () => {
    const appels = collecter(projets(), 'livreur');
    expect(appels.map((a) => [a.opus, a.total, a.ratee, a.reponse])).toEqual([
      [2230, 2230, false, 'L84 livré abc1234, QA à lancer http://x'],
      [0, 1115, true, 'Question : la porte est rouge'],
    ]);
    expect(collecter(projets(), 'code-reviewer').map((a) => a.reponse)).toEqual(['Verdict: conforme']);
  });

  it('rend une ligne par livraison et la synthèse ; --dernieres et --since filtrent', () => {
    const p = projets();
    expect(main(['--projects', p])).toMatch(/livreur : 2 appel\(s\), jetons Opus médiane 1115, total 2230 ; ratées 1$/);
    expect(main(['--projects', p, '--dernieres', '1'])).toMatch(/1 appel\(s\), jetons Opus médiane 0, total 0 ; ratées 1$/);
    expect(main(['--projects', p, '--since', ts(2)])).toMatch(/1 appel\(s\)/);
    expect(JSON.parse(main(['--projects', p, '--json']))).toHaveLength(2);
    expect(main(['--projects', join(p, 'absent')])).toBe('livreur : aucun appel trouvé');
  });

  it('nom court, réponse rendue et livraison ratée', () => {
    expect(['cadence:livreur', 'cadence-livreur', 'livreur'].map(nomCourt)).toEqual(['livreur', 'livreur', 'livreur']);
    expect(reponseDe(reponse('a', 'm', U, [{ type: 'text', text: '  \nL84 poussé 3d6edf4 avec le commit du plan 9a1b2c3\nsuite' }]))).toBe('L84 poussé 3d6edf4 avec le commit du plan 9a1b2c3');
    expect([estRatee('L84 livré 3d6edf4'), estRatee('Question : x'), estRatee('')]).toEqual([false, true, true]);
  });

  // Revue L757 r1 : sur les journaux réels, le sous-agent rend sa réponse par l'outil SubagentHandback (tool_use, input.message),
  // et le dernier bloc texte n'est qu'une phrase intermédiaire (ou rien) : 18/18 livraisons réelles étaient classées RATÉE.
  const rendu = (id: string, message: string) => reponse(id, 'claude-sonnet-5-5', U, [{ type: 'tool_use', id: `h${id}`, name: 'SubagentHandback', input: { message } }]);

  it('lit la réponse rendue dans SubagentHandback.input.message, le dernier texte seulement à défaut', () => {
    const t = [user('Livre L84'), reponse('a', 'claude-sonnet-5-5', U, [{ type: 'text', text: 'Je pousse le sha puis je lance deliver.' }]),
      rendu('b', '\nL84 livré 3d6edf4, QA à lancer http://x\ndétail')].join('\n');
    expect(reponseDe(t)).toBe('L84 livré 3d6edf4, QA à lancer http://x');
    expect(estRatee(reponseDe(t))).toBe(false);
    const sansTexte = [user('Livre L85'), rendu('c', 'Question : la porte est rouge')].join('\n');
    expect(reponseDe(sansTexte)).toBe('Question : la porte est rouge');
    const texteApres = [rendu('d', 'L86 poussé 1234567'), reponse('e', 'claude-sonnet-5-5', U, [{ type: 'text', text: 'fin' }])].join('\n');
    expect(reponseDe(texteApres)).toBe('L86 poussé 1234567');
  });

  it('deux appels au même prompt : chaque sous-agent est relié à son propre appel, dans l\'ordre', () => {
    const p = tempDir(), d = join(p, '-home-x-projet'), sous = join(d, 's', 'subagents');
    mkdirSync(sous, { recursive: true });
    writeFileSync(join(d, 's.jsonl'), [appelAgent(1, 'cadence:livreur', 'Livre L84'), appelAgent(30, 'cadence:livreur', 'Livre L84')].join('\n'));
    const premier = (m: number) => JSON.stringify({ type: 'user', timestamp: ts(m), message: { role: 'user', content: 'Livre L84' } });
    // noms de fichiers dans l'ordre inverse des dates : seule la date du premier message range les sous-agents
    writeFileSync(join(sous, 'agent-a.jsonl'), [premier(31), rendu('y', 'L84 livré 2222222')].join('\n'));
    writeFileSync(join(sous, 'agent-z.jsonl'), [premier(2), rendu('x', 'Question : la porte est rouge')].join('\n'));
    const appels = collecter(p, 'livreur');
    expect(appels.map((a) => [a.date, a.reponse])).toEqual([[ts(1), 'Question : la porte est rouge'], [ts(30), 'L84 livré 2222222']]);
    expect(main(['--projects', p, '--since', ts(10)])).toMatch(/1 appel\(s\), .* ; ratées 0$/);
  });
});
