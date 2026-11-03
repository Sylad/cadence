import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { run } from '../src/cli.js';
import { atWaveEnd, newWaveGesture, resumeCommand } from '../src/orchestrate/geste.js';

// L556 — le hook « retour → geste » : le refus d'une commande cadence/raf revient avec le geste exact, et un rappel contre la boucle d'attente.
async function hook(sub: string | null, stdin: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(sub === null ? ['claude-hook'] : ['claude-hook', sub], { cwd: process.cwd(), env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(), stdin: () => stdin });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const post = (command: string, stdout: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' }, ...extra });
const failure = (command: string, error: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error, ...extra });
const retour = (stdin: string) => hook('retour', stdin);
const context = (out: string): string => (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
const gestes = (out: string): string[] => context(out).split('\n').slice(1);
const CMD = 'cadence orchestrate a:L1';
const silent = { code: 0, out: '', err: '' };

describe('L556 — le geste d’un refus connu (R1, R4, R6)', () => {
  it('R1 — « une orchestration y est déjà en cours (2026-11-03-2100-cad, pid 42) » : le geste nomme la vague, interdit la boucle et donne cadence orchestrate --status', async () => {
    const r = await retour(post(CMD, 'cadence : une orchestration y est déjà en cours (2026-11-03-2100-cad, pid 42)'));
    expect(r.code).toBe(0);
    const [g] = gestes(r.out);
    expect(g).toContain('2026-11-03-2100-cad');
    expect(g).toContain('ne pas boucler');
    expect(g).toContain('cadence orchestrate --status');
  });
  it("R1 — « le lot n'est pas rendu à l'étape d'intégration (doing, étape work : sans cause) » sans « le geste » : le geste est cadence orchestrate --status", async () => {
    const r = await retour(post(CMD, "--integrate a:L1 : le lot n'est pas rendu à l'étape d'intégration (doing, étape work : sans cause)"));
    expect(gestes(r.out)).toHaveLength(1);
    expect(gestes(r.out)[0]).toContain('cadence orchestrate --status');
  });
  it('R1 — « la vague w1 tourne encore (pid 7, verrou de depot) » : le geste est « à la fin de la vague : cadence orchestrate --resume --wave w1 »', async () => {
    const r = await retour(post(CMD, 'la vague w1 tourne encore (pid 7, verrou de depot)'));
    expect(gestes(r.out)).toEqual(['à la fin de la vague : cadence orchestrate --resume --wave w1']);
  });
  it('R1 — « a:L1 : lot déjà dans la vague w1 » : le geste dit que le lot y est déjà et donne cadence orchestrate --status', async () => {
    const r = await retour(post(CMD, 'a:L1 : lot déjà dans la vague w1'));
    const [g] = gestes(r.out);
    expect(g).toContain('déjà dans la vague');
    expect(g).toContain('cadence orchestrate --status');
  });
  it('R1 — « a:L1 : le budget restant de la vague (1000 tokens) ne tient pas le budget du lot (50000) » : le geste est « à la fin de la vague : cadence orchestrate a:L1 »', async () => {
    const r = await retour(post(CMD, 'a:L1 : le budget restant de la vague (1000 tokens) ne tient pas le budget du lot (50000)'));
    expect(gestes(r.out)).toEqual(['à la fin de la vague : cadence orchestrate a:L1']);
  });
  it("R1 — le même texte écrit « lot déjà en file d'ajout dans la vague w1 » donne le geste du lot déjà dans la vague", async () => {
    const a = await retour(post(CMD, "a:L1 : lot déjà en file d'ajout dans la vague w1"));
    const b = await retour(post(CMD, 'a:L1 : lot déjà dans la vague w1'));
    expect(gestes(a.out)).toEqual(gestes(b.out));
  });
  it('R1 — un texte « lot déjà » sans « dans la vague » (titre, note, état) n’est pas le refus du lot déjà dans la vague : aucune sortie', async () => {
    for (const text of ['title: Reprendre un lot déjà commencé', 'lot déjà en file', 'a:L1 : lot déjà retiré →']) {
      expect(await retour(post('raf show L9', text))).toEqual(silent);
    }
  });
  it('R4 — le geste de « tourne encore » est identique, caractère pour caractère, à la sortie de resumeCommand et atWaveEnd pour la même vague', async () => {
    const r = await retour(post(CMD, 'la vague w1 tourne encore (pid 7)'));
    expect(gestes(r.out)).toEqual([atWaveEnd(resumeCommand('w1'))]);
  });
  it("R4 — le geste de « budget » est identique à atWaveEnd(newWaveGesture('a:L1'))", async () => {
    const r = await retour(post(CMD, 'a:L1 : le budget restant de la vague (1) ne tient pas le budget du lot (2)'));
    expect(gestes(r.out)).toEqual([atWaveEnd(newWaveGesture('a:L1'))]);
  });
  it('R4 — la table est exportée par src/orchestrate/geste.ts et la commande claude-hook l’importe : aucun littéral « --resume --wave » dans le module du hook', () => {
    const hookSource = readFileSync(new URL('../src/claude-hook.ts', import.meta.url), 'utf8');
    expect(hookSource).toMatch(/from '\.\/orchestrate\/geste\.js'/);
    expect(hookSource).not.toContain('--resume --wave');
    expect(readFileSync(new URL('../src/orchestrate/geste.ts', import.meta.url), 'utf8')).toMatch(/export function refusalGestures/);
  });
  it('R6 — refus « tourne encore » sans nom de vague lisible : le geste porte <vague>', async () => {
    const r = await retour(post(CMD, 'la vague tourne encore'));
    expect(gestes(r.out)).toEqual(['à la fin de la vague : cadence orchestrate --resume --wave <vague>']);
  });
  it('R6 — refus de budget sans clé projet:lot en tête de ligne : le geste porte <projet:lot>', async () => {
    const r = await retour(post(CMD, 'le budget restant de la vague ne tient pas le budget du lot (5)'));
    expect(gestes(r.out)).toEqual(['à la fin de la vague : cadence orchestrate <projet:lot>']);
  });
  it('R6 — aucun geste ne contient un id absent de la sortie et de la commande', async () => {
    const texts = ["la vague tourne encore", 'une orchestration y est déjà en cours', 'lot déjà dans la vague', 'ne tient pas le budget du lot'];
    for (const t of texts) {
      const r = await retour(post(CMD, t));
      expect(context(r.out)).not.toMatch(/\b\d{4}-\d{2}-\d{2}-\d{4}|\bw\d\b|\bL\d+\b/);
    }
  });
});

describe('L556 — la ligne d’avancement n’est pas un refus (R2)', () => {
  const PROGRESS = "orchestrate : depot : tenu par la vague w1 (pid 7) : attente de sa fin avant de reprendre l'intégration";
  it('R2 — la ligne « tenu par la vague w1 (pid 7) : attente de sa fin avant de reprendre l’intégration » seule : aucune sortie du hook', async () => {
    expect(await retour(post(CMD, PROGRESS))).toEqual(silent);
    expect(await retour(failure(CMD, `Exit code 2\n${PROGRESS}`))).toEqual(silent);
  });
  it('R2 — la même ligne suivie d’un vrai refus « une orchestration y est déjà en cours » : un seul geste, celui du refus', async () => {
    const r = await retour(post(CMD, `${PROGRESS}\ndepot : une orchestration y est déjà en cours (w2, pid 9)`));
    expect(gestes(r.out)).toHaveLength(1);
    expect(gestes(r.out)[0]).toContain('w2');
  });
});

describe('L556 — les segments cadence/raf de la commande (R3)', () => {
  const REFUSAL = 'la vague w1 tourne encore (pid 7)';
  const speaks = async (command: string) => (await retour(post(command, REFUSAL))).out !== '';
  it('R3 — « cd x && cadence orchestrate a:L1 » : segment reconnu, geste rendu', async () => {
    expect(await speaks('cd x && cadence orchestrate a:L1')).toBe(true);
  });
  it('R3 — « npx cadence orchestrate --resume », « FOO=1 cadence verify » et « /opt/bin/cadence deliver » : reconnus', async () => {
    for (const c of ['npx cadence orchestrate --resume', 'FOO=1 cadence verify', '/opt/bin/cadence deliver', 'raf done L1', 'ls | cadence verify', 'a;\ncadence orchestrate b']) expect(await speaks(c)).toBe(true);
  });
  it('R3 — « echo cadence ; ls » et « grep raf notes.txt » avec un refus connu dans la sortie : aucune sortie du hook', async () => {
    expect(await speaks('echo cadence ; ls')).toBe(false);
    expect(await speaks('grep raf notes.txt')).toBe(false);
  });
  it('R3 — « cadencex orchestrate » : non reconnu, aucune sortie', async () => {
    expect(await speaks('cadencex orchestrate')).toBe(false);
  });
  it("R3 — « git commit -m 'cadence : une orchestration y est déjà en cours' » : aucune sortie", async () => {
    expect(await retour(post("git commit -m 'cadence : une orchestration y est déjà en cours'", "[main abc] cadence : une orchestration y est déjà en cours"))).toEqual(silent);
  });
});

describe('L556 — le code 137 (R5)', () => {
  it('R5 — « cadence orchestrate a:L1 --wave w9 » et erreur « Exit code 137 » : le geste est cadence orchestrate --resume --wave w9', async () => {
    const r = await retour(failure('cadence orchestrate a:L1 --wave w9', 'Exit code 137'));
    expect(gestes(r.out)).toEqual([resumeCommand('w9')]);
  });
  it('R5 — « cadence orchestrate a:L1 » sans --wave, erreur « Exit code 137 » : le geste porte <vague>, jamais un id inventé', async () => {
    const r = await retour(failure(CMD, 'Exit code 137'));
    expect(gestes(r.out)).toEqual([resumeCommand('<vague>')]);
  });
  it('R5 — « cadence verify --gate --sha HEAD » et « Exit code 137 » : le geste dit de relancer en tâche de fond', async () => {
    const r = await retour(failure('cadence verify --gate --sha HEAD', 'Exit code 137'));
    expect(gestes(r.out)[0]).toContain('relancer');
    expect(gestes(r.out)[0]).toContain('tâche de fond');
    expect(gestes(r.out)[0]).not.toContain('--resume');
  });
  it('R5 — « sleep 9 » et « Exit code 137 » : aucune sortie du hook', async () => {
    expect(await retour(failure('sleep 9', 'Exit code 137'))).toEqual(silent);
  });
  it('R5 — « Exit code 1370 » ou « Exit code 13 » : pas le code 137, aucune sortie', async () => {
    expect(await retour(failure(CMD, 'Exit code 1370'))).toEqual(silent);
    expect(await retour(failure(CMD, 'Exit code 13'))).toEqual(silent);
  });
  it('R5 — le code de sortie 137 de la réponse de l’outil (exit_code) rend le même geste', async () => {
    const r = await retour(JSON.stringify({ tool_input: { command: 'cadence orchestrate a:L1 --wave w9' }, tool_response: { stdout: '', exit_code: 137 } }));
    expect(gestes(r.out)).toEqual([resumeCommand('w9')]);
  });
});

describe('L556 — l’option inconnue (R7)', () => {
  it("R7 — « raf: Unknown option '--bogus'. To specify a positional argument … » : le geste cite --bogus et donne cadence --help", async () => {
    const r = await retour(failure('raf done L1 --bogus', "Exit code 2\nraf: Unknown option '--bogus'. To specify a positional argument starting with a '-', place it at the end of the command after '--'"));
    expect(gestes(r.out)).toHaveLength(1);
    expect(gestes(r.out)[0]).toContain('--bogus');
    expect(gestes(r.out)[0]).toContain('cadence --help');
  });
  it('R7 — « option inconnue : --bogus » (orchestrate) : le geste cite --bogus et donne cadence --help', async () => {
    const r = await retour(failure('cadence orchestrate --bogus', 'Exit code 2\norchestrate : option inconnue : --bogus'));
    expect(gestes(r.out)[0]).toContain('--bogus');
    expect(gestes(r.out)[0]).toContain('cadence --help');
  });
  it('R7 — le geste ne contient jamais « orchestrate --help »', async () => {
    const r = await retour(failure('cadence orchestrate --help', 'Exit code 2\norchestrate : option inconnue : --help'));
    expect(context(r.out)).not.toContain('orchestrate --help');
  });
  it('R7 — « Unknown option » sans nom d’option lisible : le geste est cadence --help sans nom', async () => {
    const r = await retour(failure(CMD, 'Exit code 2\nraf: Unknown option'));
    expect(gestes(r.out)).toEqual(['cadence --help (la liste des commandes et de leurs options)']);
  });
});

describe('L556 — le refus qui porte déjà son geste (R8)', () => {
  it("R8 — « le lot n'est pas rendu à l'étape d'intégration (…) — le geste : cadence orchestrate --resume --wave w1 --integrate a:L1 » : aucune sortie", async () => {
    expect(await retour(post(CMD, "--integrate a:L1 : le lot n'est pas rendu à l'étape d'intégration (doing, étape work : x) — le geste : cadence orchestrate --resume --wave w1 --integrate a:L1"))).toEqual(silent);
  });
  it('R8 — « la vague w1 tourne encore (pid 7) : à la fin de la vague : cadence orchestrate --resume --wave w1 --integrate a:L1 » : aucune sortie', async () => {
    expect(await retour(post(CMD, 'la vague w1 tourne encore (pid 7) : à la fin de la vague : cadence orchestrate --resume --wave w1 --integrate a:L1'))).toEqual(silent);
  });
  it('R8 — « a:L1 : lot déjà dans la vague w1 : retiré de la vague : le lancer dans une nouvelle vague, à la fin de la vague : cadence orchestrate a:L1 » : aucune sortie', async () => {
    expect(await retour(post(CMD, 'a:L1 : lot déjà dans la vague w1 : retiré de la vague : le lancer dans une nouvelle vague, à la fin de la vague : cadence orchestrate a:L1'))).toEqual(silent);
  });
  it("R8 — un --replay refusé (« pas rendu à l'étape d'intégration ni sur une écriture de plan refusée ») suivi, sur sa propre ligne, de « la reprise sans --replay : … » : aucune sortie", async () => {
    // withReplayHint imprime l'indication sur une ligne à part, après les refus : le geste porte sur toute la reprise, les lignes au-dessus n'en reçoivent aucun.
    const out = [
      "orchestrate : --replay a:L1 : le lot n'est pas rendu à l'étape d'intégration ni sur une écriture de plan refusée (doing, étape work : sans cause)",
      'orchestrate : un --replay refusé refuse toute la reprise : la reprise sans --replay : cadence orchestrate --resume --wave w1 --integrate "b:L2"',
    ].join('\n');
    expect(await retour(failure('cadence orchestrate --resume --wave w1 --replay a:L1 --integrate b:L2', `Exit code 2\n${out}`))).toEqual(silent);
  });
  it("R8 — un refus qui suit la ligne « la reprise sans --replay : » dans la même sortie (une autre commande du segment) garde son geste", async () => {
    const out = ['orchestrate : un --replay refusé refuse toute la reprise : la reprise sans --replay : cadence orchestrate --resume --wave w1', 'la vague w2 tourne encore (pid 7)'].join('\n');
    expect(gestes((await retour(post(CMD, out))).out)).toEqual([atWaveEnd(resumeCommand('w2'))]);
  });
});

describe('L556 — le hook ne gêne jamais (R9)', () => {
  it('R9 — retour, entrée vide : code 0, sortie standard et d’erreur vides', async () => {
    expect(await retour('')).toEqual(silent);
  });
  it('R9 — retour, « {pas du json » : code 0, rien d’imprimé', async () => {
    expect(await retour('{pas du json')).toEqual(silent);
  });
  it('R9 — retour (PostToolUse), tool_response absent : code 0, rien d’imprimé', async () => {
    expect(await retour(JSON.stringify({ hook_event_name: 'PostToolUse', tool_input: { command: CMD } }))).toEqual(silent);
  });
  it('R9 — retour (PostToolUseFailure), champ error absent : code 0, rien d’imprimé', async () => {
    expect(await retour(JSON.stringify({ hook_event_name: 'PostToolUseFailure', tool_input: { command: CMD } }))).toEqual(silent);
  });
  it('R9 — rappel, entrée vide, JSON invalide et tool_input.command absent : code 0, rien d’imprimé', async () => {
    expect(await hook('attente', '')).toEqual(silent);
    expect(await hook('attente', 'pas json')).toEqual(silent);
    expect(await hook('attente', JSON.stringify({ tool_input: {} }))).toEqual(silent);
    expect(await hook('attente', JSON.stringify({}))).toEqual(silent);
  });
  it('R9 — tool_input.command de type nombre : code 0, rien d’imprimé', async () => {
    expect(await hook('attente', JSON.stringify({ tool_input: { command: 12 } }))).toEqual(silent);
    expect(await retour(JSON.stringify({ tool_input: { command: 12 }, tool_response: 'la vague w1 tourne encore' }))).toEqual(silent);
    expect(await retour(JSON.stringify({ tool_input: { command: CMD }, tool_response: { stdout: 5, stderr: [] }, error: {} }))).toEqual(silent);
  });
  it('R9 — une sortie de 5 Mo sans refus : code 0, rien d’imprimé, en moins d’une seconde', async () => {
    const big = `${'x'.repeat(99)}\n`.repeat(50_000);
    const start = Date.now();
    expect(await retour(post(CMD, big))).toEqual(silent);
    expect(await retour(post(CMD, 'y'.repeat(5_000_000)))).toEqual(silent);
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it('R9 — cadence claude-hook sans sous-commande ou avec un nom inconnu : code 0, rien d’imprimé', async () => {
    const withRefusal = post(CMD, 'la vague w1 tourne encore');
    expect(await hook(null, withRefusal)).toEqual(silent);
    expect(await hook('inconnu', withRefusal)).toEqual(silent);
  });
});

describe('L556 — la commande retour lit les deux formes d’entrée (R11)', () => {
  const REFUSAL = 'la vague w1 tourne encore (pid 7)';
  it('R11 — PostToolUse avec tool_response.stdout portant un refus : le geste est rendu', async () => {
    expect((await retour(post(CMD, REFUSAL))).out).not.toBe('');
  });
  it('R11 — PostToolUse avec tool_response.stderr portant un refus : le geste est rendu', async () => {
    const r = await retour(JSON.stringify({ hook_event_name: 'PostToolUse', tool_input: { command: CMD }, tool_response: { stdout: '', stderr: REFUSAL } }));
    expect(gestes(r.out)).toHaveLength(1);
  });
  it('R11 — PostToolUseFailure avec error portant un refus : le geste est rendu avec hookEventName PostToolUseFailure', async () => {
    const r = await retour(failure(CMD, `Exit code 2\n${REFUSAL}`));
    expect(gestes(r.out)).toHaveLength(1);
    expect((JSON.parse(r.out) as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
  });
  it('R11 — tool_response donné sous forme d’un texte seul : le geste est rendu', async () => {
    const r = await retour(JSON.stringify({ hook_event_name: 'PostToolUse', tool_input: { command: CMD }, tool_response: REFUSAL }));
    expect(gestes(r.out)).toHaveLength(1);
  });
});

describe('L556 — la forme de la sortie du hook (R12)', () => {
  it('R12 — la sortie est un JSON unique dont hookSpecificOutput.additionalContext commence par « retour → geste : »', async () => {
    const r = await retour(post(CMD, 'la vague w1 tourne encore'));
    expect(r.out.split('\n')).toHaveLength(1);
    expect(context(r.out).startsWith('retour → geste :')).toBe(true);
    expect(r.err).toBe('');
  });
  it('R12 — hookEventName reprend celui de l’entrée (PostToolUse, PostToolUseFailure ou PreToolUse)', async () => {
    const event = (out: string) => (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput.hookEventName;
    expect(event((await retour(post(CMD, 'la vague w1 tourne encore'))).out)).toBe('PostToolUse');
    expect(event((await retour(failure(CMD, 'la vague w1 tourne encore'))).out)).toBe('PostToolUseFailure');
    expect(event((await hook('attente', JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'while pgrep -f x; do :; done' } }))).out)).toBe('PreToolUse');
  });
  it('R12 — le rappel cite Monitor, cadence orchestrate --status et la notification de fin, sans citer sleep comme solution', async () => {
    const r = await hook('attente', JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'while pgrep -f x; do sleep 5; done' } }));
    const text = context(r.out);
    expect(text.startsWith('rappel :')).toBe(true);
    expect(text).toContain('Monitor');
    expect(text).toContain('cadence orchestrate --status');
    expect(text).toContain('notification de fin');
    expect(text).not.toContain('sleep');
  });
});

describe('L556 — la boucle d’attente (R13)', () => {
  const reminded = async (command: string) => (await hook('attente', JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command } }))).out !== '';
  it("R13 — « while pgrep -f 'cadence orchestrate' >/dev/null; do sleep 5; done » : le rappel est rendu", async () => {
    expect(await reminded("while pgrep -f 'cadence orchestrate' >/dev/null; do sleep 5; done")).toBe(true);
  });
  it('R13 — « until ! pgrep -af vitest; do sleep 2; done ; echo fini » : le rappel est rendu', async () => {
    expect(await reminded('until ! pgrep -af vitest; do sleep 2; done ; echo fini')).toBe(true);
    expect(await reminded('while pgrep -fl vitest; do sleep 2; done')).toBe(true);
  });
  it('R13 — « pgrep -f cadence » sans boucle : aucune sortie', async () => {
    expect(await reminded('pgrep -f cadence')).toBe(false);
  });
  it('R13 — « while read l; do echo $l; done < f » : aucune sortie', async () => {
    expect(await reminded('while read l; do echo $l; done < f')).toBe(false);
    expect(await reminded('while true; do pgrep -f x; done')).toBe(false);
    expect(await reminded('while pgrep x; do sleep 1; done')).toBe(false);
  });
  it("R13 — « grep -r 'while pgrep -f' docs » : le rappel est rendu (détection textuelle, faux positif accepté)", async () => {
    expect(await reminded("grep -r 'while pgrep -f' docs")).toBe(true);
  });
});

describe('L556 — plusieurs refus (R14)', () => {
  it('R14 — le même refus répété 50 fois : un seul geste', async () => {
    const r = await retour(post(CMD, `${'la vague w1 tourne encore (pid 7)\n'.repeat(50)}`));
    expect(gestes(r.out)).toHaveLength(1);
  });
  it('R14 — deux refus de motifs différents : deux gestes, dans l’ordre de la sortie', async () => {
    const r = await retour(post(CMD, 'a:L1 : lot déjà dans la vague w1\nla vague w1 tourne encore (pid 7)'));
    expect(gestes(r.out)).toHaveLength(2);
    expect(gestes(r.out)[0]).toContain('déjà dans la vague');
    expect(gestes(r.out)[1]).toContain('--resume');
  });
  it('R14 — huit refus distincts : cinq gestes', async () => {
    const out = Array.from({ length: 8 }, (_, i) => `la vague w${i} tourne encore (pid 7)`).join('\n');
    expect(gestes((await retour(post(CMD, out))).out)).toHaveLength(5);
  });
});

describe('L556 — le sous-agent (R15)', () => {
  it('R15 — retour avec agent_id et un refus connu : aucune sortie', async () => {
    expect(await retour(post(CMD, 'la vague w1 tourne encore', { agent_id: 'a1' }))).toEqual(silent);
  });
  it('R15 — rappel avec agent_id et une boucle d’attente : aucune sortie', async () => {
    expect(await hook('attente', JSON.stringify({ agent_id: 'a1', tool_input: { command: 'while pgrep -f x; do :; done' } }))).toEqual(silent);
  });
  it('R15 — sans agent_id, les mêmes entrées rendent le geste et le rappel', async () => {
    expect((await retour(post(CMD, 'la vague w1 tourne encore'))).out).not.toBe('');
    expect((await hook('attente', JSON.stringify({ tool_input: { command: 'while pgrep -f x; do :; done' } }))).out).not.toBe('');
  });
});

describe('L556 — hooks/hooks.json du plugin (R10)', () => {
  const file = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')) as { hooks: Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]> };
  const commandOf = (event: string): string => file.hooks[event]![0]!.hooks[0]!.command;
  it('R10 — hooks/hooks.json est un JSON valide, déclare les trois événements sur le matcher Bash et leurs commandes cadence claude-hook retour / attente', () => {
    expect(Object.keys(file.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
    for (const event of Object.keys(file.hooks)) {
      expect(file.hooks[event]).toHaveLength(1);
      expect(file.hooks[event]![0]!.matcher).toBe('Bash');
      expect(file.hooks[event]![0]!.hooks[0]!.type).toBe('command');
    }
    expect(commandOf('PostToolUse')).toContain('cadence claude-hook retour');
    expect(commandOf('PostToolUseFailure')).toContain('cadence claude-hook retour');
    expect(commandOf('PreToolUse')).toContain('cadence claude-hook attente');
  });
  it('R10 — la commande de chaque ligne sort en 0 sans texte quand cadence est absent du PATH', () => {
    for (const event of Object.keys(file.hooks)) {
      const out = execFileSync('/bin/sh', ['-c', commandOf(event)], { env: { PATH: '/nonexistent' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out).toBe('');
    }
  });
  it('R10 — hooks/hooks.json n’est pas confondu avec plugins/cadence-hud/hooks/hooks.json, qui reste inchangé', () => {
    const hud = JSON.parse(readFileSync(new URL('../plugins/cadence-hud/hooks/hooks.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(hud).toHaveProperty('modules');
    expect(hud).not.toHaveProperty('hooks');
    expect(file).not.toHaveProperty('modules');
  });
});

describe('L556 — le 137 lu dans le seul champ error (R5, revue L556)', () => {
  it('R5 — « raf show L556 » sortie 0, stdout contenant « Exit code 137 » dans un titre : aucun geste', async () => {
    expect(await retour(post('raf show L556', 'L556 [doing] hook — « Exit code 137 » de l’événement d’échec'))).toEqual(silent);
  });
  it('R5 — « cadence verify » sortie 0, stdout contenant « Exit code 137 » : aucun geste (seul le champ error porte le code)', async () => {
    expect(await retour(post('cadence verify', 'note : Exit code 137 vu hier'))).toEqual(silent);
  });
  it('R5 — tool_response en texte contenant « Exit code 137 » : aucun geste', async () => {
    expect(await retour(JSON.stringify({ hook_event_name: 'PostToolUse', tool_input: { command: CMD }, tool_response: 'Exit code 137' }))).toEqual(silent);
  });
});

describe('L556 — seules les commandes qui peuvent refuser sont lues (R16)', () => {
  const ALREADY = 'L9 [todo] titre : « a:L1 : lot déjà dans la vague w1 »';
  it('R16 — raf show d’un lot dont le titre contient « lot déjà dans la vague » : aucune sortie', async () => {
    expect(await retour(post('raf show L9', ALREADY))).toEqual(silent);
  });
  it('R16 — raf list, raf now, cadence lead tour, cadence orchestrate --status, --dry-run et cadence session start qui citent un refus : aucune sortie', async () => {
    for (const c of ['raf list', 'raf now', 'cadence lead tour', 'cadence orchestrate --status', 'cadence orchestrate a:L1 --dry-run', 'cadence session start']) {
      expect(await retour(post(c, `${ALREADY}\nla vague w1 tourne encore (pid 7)`))).toEqual(silent);
    }
  });
  it('R16 — « cadence orchestrate --add a:L1 » qui imprime « lot déjà dans la vague w1 » : geste rendu', async () => {
    const r = await retour(failure('cadence orchestrate --add a:L1', 'Exit code 2\norchestrate : a:L1 : lot déjà dans la vague w1'));
    expect(gestes(r.out)).toHaveLength(1);
    expect(gestes(r.out)[0]).toContain('cadence orchestrate --status');
  });
  it('R16 — cadence deliver, spec reseal|green, local start et raf add|start|done|review|ux|docs-ok sont lus', async () => {
    for (const c of ['cadence deliver', 'cadence spec reseal x', 'cadence spec green x', 'cadence local start L1', 'raf add "t"', 'raf start L1', 'raf done L1', 'raf review L1 ok', 'raf ux L1 ok', 'raf docs-ok L1']) {
      expect((await retour(post(c, 'la vague w1 tourne encore (pid 7)'))).out, c).not.toBe('');
    }
  });
  it('R16 — cadence spec show (lecture) qui cite un refus : aucune sortie', async () => {
    expect(await retour(post('cadence spec show x', 'la vague w1 tourne encore (pid 7)'))).toEqual(silent);
  });
  it('R16 — une commande de lecture tuée (Exit code 137 dans error) garde le geste du 137 (R5)', async () => {
    const r = await retour(failure('raf show L9', 'Exit code 137'));
    expect(gestes(r.out)[0]).toContain('tâche de fond');
  });
});
