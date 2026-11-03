import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

// L556 — sonde des bords du hook « retour → geste » (R3, R5, R7, R9, R13, R14) : écrite sans lire les tests du lot, sur la forme réelle des refus.
async function hook(sub: string, stdin: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['claude-hook', sub], { cwd: process.cwd(), env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(), stdin: () => stdin });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const post = (command: string, stdout: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' }, ...extra });
const failure = (command: string, error: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error, ...extra });
const gestes = (out: string): string[] => (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext.split('\n').slice(1);
const REFUS = 'cadence : une orchestration y est déjà en cours (w1, pid 4)';

describe('L556 sonde — R3 : les segments cadence/raf', () => {
  it('R3 — « git commit -m "x; cadence verify" » : un « ; » dans des guillemets ne fait pas un segment cadence — aucune sortie attendue', async () => {
    const r = await hook('retour', post('git commit -m "x; cadence verify"', REFUS));
    expect(r.out).toBe('');
  });
  it('R3 — « FOO="a b" cadence verify » : affectation à valeur entre guillemets avec espace — segment reconnu, geste attendu', async () => {
    const r = await hook('retour', post('FOO="a b" cadence verify', REFUS));
    expect(r.out).not.toBe('');
  });
  it('R3 — commande multi-ligne « echo a\\ncadence orchestrate a:L1 » : segment après retour à la ligne reconnu', async () => {
    const r = await hook('retour', post('echo a\ncadence orchestrate a:L1', REFUS));
    expect(gestes(r.out)).toHaveLength(1);
  });
  it('R3 — « cadence orchestrate a:L1 2>&1 | tail -5 » : reconnu', async () => {
    const r = await hook('retour', post('cadence orchestrate a:L1 2>&1 | tail -5', REFUS));
    expect(gestes(r.out)).toHaveLength(1);
  });
  it('R3 — commande vide, espaces seuls ou « && » seul avec un refus : aucune sortie, code 0', async () => {
    for (const c of ['', '   ', '&&', ';;', 'npx']) {
      const r = await hook('retour', post(c, REFUS));
      expect(r).toEqual({ code: 0, out: '', err: '' });
    }
  });
});

describe('L556 sonde — R5 : le code 137', () => {
  it('R5 — PostToolUseFailure avec tool_response: null et error « Exit code 137 » : le geste est rendu (null lu comme absent)', async () => {
    const r = await hook('retour', failure('cadence orchestrate a:L1 --wave w9', 'Exit code 137', { tool_response: null }));
    expect(gestes(r.out)).toEqual(['cadence orchestrate --resume --wave w9']);
  });
  it('R5 — tool_response: null avec un refus connu dans error : le geste est rendu', async () => {
    const r = await hook('retour', failure('cadence orchestrate a:L1', REFUS, { tool_response: null }));
    expect(r.out).not.toBe('');
  });
  it('R5 — « --wave=w9 » (forme avec égal) : la reprise nomme w9 ; « --wave » en dernier mot : <vague>', async () => {
    const a = await hook('retour', failure('cadence orchestrate a:L1 --wave=w9', 'Exit code 137'));
    expect(gestes(a.out)[0]).toContain('--wave w9');
    const b = await hook('retour', failure('cadence orchestrate a:L1 --wave', 'Exit code 137'));
    expect(gestes(b.out)[0]).toContain('<vague>');
  });
  it('R5 — exit_code 138 ou 1 (réponse de l’outil), commande cadence : aucune sortie', async () => {
    for (const code of [138, 1, 0]) {
      const r = await hook('retour', JSON.stringify({ tool_input: { command: 'cadence verify' }, tool_response: { stdout: '', stderr: '', exit_code: code } }));
      expect(r.out).toBe('');
    }
  });
  it('R5 — « Exit code 137 » au milieu d’un autre texte (« Exit code 1371 », « xExit code 137 ») : « Exit code 137 » collé à un préfixe lu comme le code (limite acceptée) — seul 1371 ne doit rien rendre', async () => {
    const r = await hook('retour', failure('cadence verify', 'Exit code 1371'));
    expect(r.out).toBe('');
  });
});

describe('L556 sonde — R7 : l’option inconnue', () => {
  it('R7 — deux options inconnues différentes : deux gestes ; la même deux fois : un seul', async () => {
    const two = await hook('retour', failure('cadence verify', "raf: Unknown option '--a'.\nraf: Unknown option '--b'."));
    expect(gestes(two.out)).toHaveLength(2);
    const same = await hook('retour', failure('cadence verify', "raf: Unknown option '--a'.\nraf: Unknown option '--a'."));
    expect(gestes(same.out)).toHaveLength(1);
  });
  it('R7 — « Unknown option \'-x\' » (option courte) : le geste cite -x', async () => {
    const r = await hook('retour', failure('raf list', "raf: Unknown option '-x'."));
    expect(gestes(r.out)[0]).toContain('-x');
  });
  it('R7 — fin de ligne CRLF : le nom de l’option est lu sans \\r', async () => {
    const r = await hook('retour', failure('cadence orchestrate a:L1', 'orchestrate : option inconnue : --bogus\r\n'));
    expect(gestes(r.out)[0]).toContain('--bogus');
    expect(gestes(r.out)[0]).not.toContain('\r');
  });
});

describe('L556 sonde — forme réelle des refus (R1, R6, R8)', () => {
  it('R1 — « orchestrate : a:L1 : lot déjà dans la vague w1 » (préfixe réel) : le geste nomme a:L1', async () => {
    const r = await hook('retour', failure('cadence orchestrate a:L1', 'orchestrate : a:L1 : lot déjà dans la vague w1'));
    expect(gestes(r.out)[0]).toContain('a:L1');
  });
  it('R1 — « orchestrate : a:L1 : le budget restant … ne tient pas le budget du lot » (préfixe réel) : le geste nomme a:L1', async () => {
    const r = await hook('retour', failure('cadence orchestrate a:L1', 'orchestrate : a:L1 : le budget restant de la vague (1 tokens) ne tient pas le budget du lot (2)'));
    expect(gestes(r.out)[0]).toContain('cadence orchestrate a:L1');
  });
  it('R1 — « la vague w1 tourne encore (pid 7, verrou de depot) » avec fin CRLF : id de vague propre', async () => {
    const r = await hook('retour', failure('cadence orchestrate --resume', 'orchestrate : la vague w1 tourne encore (pid 7, verrou de depot)\r\n'));
    expect(gestes(r.out)[0]).toContain('--wave w1');
    expect(gestes(r.out)[0]).not.toContain('\r');
  });
  it('R1 — refus réel de local-task (« — attendre sa fin ») : un geste, la vague w1 nommée', async () => {
    const r = await hook('retour', failure('cadence local start L1', 'depot : une orchestration y est déjà en cours (w1, pid 9) — attendre sa fin'));
    expect(gestes(r.out)).toHaveLength(1);
    expect(gestes(r.out)[0]).toContain('w1');
  });
  it('R1 — « a:L1 : lot déjà … » sur deux lots différents : deux gestes nommant chacun son lot', async () => {
    const r = await hook('retour', failure('cadence orchestrate --add a:L1 a:L2', 'a:L1 : lot déjà dans la vague w1\na:L2 : lot déjà dans la vague w1'));
    const g = gestes(r.out);
    expect(g).toHaveLength(2);
    expect(g[0]).toContain('a:L1');
    expect(g[1]).toContain('a:L2');
  });
  it('R1 — sortie RÉUSSIE d’une commande qui imprime le titre d’un lot citant les refus (« raf show L556 ») : aucun geste attendu', async () => {
    const titre = "L556 Hook « retour → geste » : « une orchestration y est déjà en cours », « pas rendu à l'étape d'intégration », « Unknown option '-- », « ne tient pas le budget du lot »";
    const r = await hook('retour', post('raf show L556', titre));
    expect(r.out).toBe('');
  });
});

describe('L556 sonde — R9 : entrées de mauvais type', () => {
  it('R9 — JSON « null », « 123 », « [] », « "x" », tool_input nul ou texte : code 0, rien', async () => {
    for (const s of ['null', '123', '[]', '"x"', '{"tool_input":null}', '{"tool_input":"cadence"}', '{"tool_input":{"command":["cadence"]}}']) {
      for (const sub of ['retour', 'attente']) expect(await hook(sub, s)).toEqual({ code: 0, out: '', err: '' });
    }
  });
  it('R9 — tool_response nombre, tableau, error nombre, objet : code 0, rien', async () => {
    for (const extra of [{ tool_response: 5 }, { tool_response: [REFUS] }, { error: 5 }, { error: { m: REFUS } }, { tool_response: { stdout: 5, stderr: [REFUS] } }]) {
      const r = await hook('retour', JSON.stringify({ tool_input: { command: 'cadence verify' }, ...extra }));
      expect(r).toEqual({ code: 0, out: '', err: '' });
    }
  });
  it('R9 — une commande de 300 Ko faite de « while » répétés, sans pgrep : le hook répond en moins d’une seconde', async () => {
    const t = Date.now();
    const r = await hook('attente', JSON.stringify({ tool_input: { command: 'while '.repeat(50_000) } }));
    expect(r).toEqual({ code: 0, out: '', err: '' });
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('R9 — une sortie de 5 Mo sur une seule ligne faite de « a:b » : réponse en moins d’une seconde', async () => {
    const t = Date.now();
    const r = await hook('retour', post('cadence verify', 'a:b '.repeat(1_250_000)));
    expect(r).toEqual({ code: 0, out: '', err: '' });
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('L556 sonde — R13 : la boucle d’attente', () => {
  it('R13 — « while pgrep -u $USER -f cadence; do sleep 1; done » : pgrep avec une option à valeur avant -f — rappel attendu', async () => {
    const r = await hook('attente', JSON.stringify({ tool_input: { command: 'while pgrep -u $USER -f cadence; do sleep 1; done' } }));
    expect(r.out).not.toBe('');
  });
  it('R13 — « while [ -n "$(pgrep -f cadence)" ]; do sleep 1; done » : rappel rendu', async () => {
    const r = await hook('attente', JSON.stringify({ tool_input: { command: 'while [ -n "$(pgrep -f cadence)" ]; do sleep 1; done' } }));
    expect(r.out).not.toBe('');
  });
  it('R13 — « meanwhile pgrep -f x » et « while true; do :; done; pgrep -f x » : aucune sortie', async () => {
    for (const c of ['meanwhile pgrep -f x', 'while true; do :; done; pgrep -f x']) {
      const r = await hook('attente', JSON.stringify({ tool_input: { command: c } }));
      expect(r.out).toBe('');
    }
  });
  it('R13 — « while pgrep -f x\\ndo sleep 1\\ndone » (do à la ligne) : rappel rendu', async () => {
    const r = await hook('attente', JSON.stringify({ tool_input: { command: 'while pgrep -f x\ndo sleep 1\ndone' } }));
    expect(r.out).not.toBe('');
  });
});

describe('L556 sonde — R14 : plafond et doublons', () => {
  const vagues = (n: number) => Array.from({ length: n }, (_, i) => `la vague w${i} tourne encore (pid ${i})`).join('\n');
  it('R14 — cinq refus distincts plus « Exit code 137 » : cinq gestes au plus', async () => {
    const r = await hook('retour', failure('cadence orchestrate a:L1', `${vagues(5)}\nExit code 137`));
    expect(gestes(r.out)).toHaveLength(5);
  });
  it('R14 — même vague avec des pid différents : un seul geste', async () => {
    const r = await hook('retour', failure('cadence orchestrate a:L1', 'la vague w1 tourne encore (pid 1)\nla vague w1 tourne encore (pid 2)'));
    expect(gestes(r.out)).toHaveLength(1);
  });
  it('R14 — le même refus dans error et dans tool_response : un seul geste', async () => {
    const r = await hook('retour', JSON.stringify({ tool_input: { command: 'cadence verify' }, error: REFUS, tool_response: { stdout: REFUS, stderr: REFUS } }));
    expect(gestes(r.out)).toHaveLength(1);
  });
  it('R14 — l’ordre suit la sortie : budget puis « déjà en cours »', async () => {
    const r = await hook('retour', failure('cadence orchestrate a:L1', `a:L1 : le budget restant (1) ne tient pas le budget du lot (2)\n${REFUS}`));
    const g = gestes(r.out);
    expect(g[0]).toContain('cadence orchestrate a:L1');
    expect(g[1]).toContain('w1');
  });
});

describe('L556 sonde — R15 : agent_id', () => {
  it('R15 — agent_id vide (chaîne vide) : le hook parle (lead) ; agent_id « x » : se tait', async () => {
    expect((await hook('retour', post('cadence verify', REFUS, { agent_id: '' }))).out).not.toBe('');
    expect((await hook('retour', post('cadence verify', REFUS, { agent_id: 'x' }))).out).toBe('');
  });
});
