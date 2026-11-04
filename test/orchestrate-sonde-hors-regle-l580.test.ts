import { describe, expect, it } from 'vitest';
import { horsRegleWarnings } from '../src/orchestrate/probe.js';
import { renderBrief, gateText, type BriefVars } from '../src/orchestrate/briefs.js';
import { PROBE_SCHEMA, checkShape, type ProbeReport } from '../src/orchestrate/schemas.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, probeReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const PREFIX = 'sonde de cas limites : attente hors règle du lot, non commitée (à reprendre en constat de revue ou en sous-tâche) : ';
const impl = (...files: string[]): Handler => (call) => claudeOut(workReport({ commits: files.map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

describe('sonde L580 — horsRegleWarnings aux bornes', () => {
  it('rapport absent, champ absent, null : aucun warning', () => {
    expect(horsRegleWarnings(undefined)).toEqual([]);
    expect(horsRegleWarnings({})).toEqual([]);
    expect(horsRegleWarnings({ horsRegle: null })).toEqual([]);
    expect(horsRegleWarnings({ horsRegle: undefined })).toEqual([]);
  });

  it('mauvais types (chaîne, objet, nombre, tableau-like) : aucun warning et pas de levée', () => {
    for (const bad of ['a — b — c', { 0: 'a', length: 1 }, 7, true, new Set(['a'])]) {
      expect(horsRegleWarnings({ horsRegle: bad })).toEqual([]);
    }
  });

  it('entrées mal typées ou blanches ignorées, texte rogné, ordre gardé', () => {
    const w = horsRegleWarnings({ horsRegle: [null, 3, {}, ['x'], '', '\n\t ', '  t — e — a  ', 'autre'] });
    expect(w).toEqual([`${PREFIX}t — e — a`, `${PREFIX}autre`]);
  });

  it('deux fois la même entrée : un warning par entrée, sans plantage', () => {
    expect(horsRegleWarnings({ horsRegle: ['x', 'x'] })).toHaveLength(2);
  });

  it('entrée multiligne : une seule ligne de warning par entrée (le texte est gardé entier)', () => {
    const [w] = horsRegleWarnings({ horsRegle: ['a — b\n— c'] });
    expect(w).toBe(`${PREFIX}a — b\n— c`);
  });
});

describe('sonde L580 — schéma du rapport', () => {
  it('horsRegle est un tableau facultatif : absent ou mal typé, checkShape accepte', () => {
    expect(PROBE_SCHEMA.properties.horsRegle.type).toBe('array');
    expect(PROBE_SCHEMA.required as readonly string[]).not.toContain('horsRegle');
    const base = { commits: [], echecs: [], nonVerifie: [], questions: [], resume: 'r' };
    expect(() => checkShape<ProbeReport>(base, PROBE_SCHEMA)).not.toThrow();
    expect(() => checkShape<ProbeReport>({ ...base, horsRegle: 'x' }, PROBE_SCHEMA)).not.toThrow();
    expect(() => checkShape<ProbeReport>({ ...base, horsRegle: ['x'] }, PROBE_SCHEMA)).not.toThrow();
  });
});

describe('sonde L580 — brief rendu réel', () => {
  const vars = (gate: string) => ({ chemin: '/r', lot: 'L580', titre: 't', objectif: 'o', commits: '- c', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '', diff: 'git diff a..b', gate } as unknown as BriefVars);

  it('le brief rendu cite le lot, garde « horsRegle » et ne laisse aucun marqueur', () => {
    const text = renderBrief('probe', vars(gateText({ test: 'npx vitest run', build: 'npx tsc --noEmit' })));
    expect(text).toContain('probe(L580)');
    expect(text).toContain('horsRegle');
    expect(text).toContain('npx vitest run');
    expect(text).not.toMatch(/\{\{\w+\}\}/);
  });

  it('sans porte déclarée, le brief se rend quand même sans trou ni marqueur', () => {
    const text = renderBrief('probe', vars(''));
    expect(text).not.toMatch(/\{\{\w+\}\}/);
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe('sonde L580 — par le cycle réel', () => {
  it('rapport illisible (echecs absent) avec horsRegle : seul « non jouée », aucun warning hors règle, la revue part', async () => {
    const bad: Handler = () => claudeOut({ commits: [], nonVerifie: [], questions: [], resume: 'r', horsRegle: ['t — e — a'] });
    const h = harness({ script: { implement: [impl('a.ts')], probe: [bad], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.warnings.join('\n')).not.toContain('hors règle du lot');
    expect(c.lot.warnings.join('\n')).toContain('sonde de cas limites non jouée');
  });

  it('horsRegle sans aucun commit de la sonde : le warning est écrit et la revue part', async () => {
    const quiet: Handler = () => claudeOut(probeReport({ horsRegle: ['t — e — a'] }));
    const h = harness({ script: { implement: [impl('a.ts')], probe: [quiet], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.warnings).toContain(`${PREFIX}t — e — a`);
    expect(c.lot.proposals).toEqual(['[hors règle] t — e — a']);
  });

  it('horsRegle : une sous-tâche proposée par entrée, sans doublon', async () => {
    const quiet: Handler = () => claudeOut(probeReport({ horsRegle: ['x — nom vide — refus', ' x — nom vide — refus ', 'y — e — a'] }));
    const h = harness({ script: { implement: [impl('a.ts')], probe: [quiet], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(c.lot.proposals).toEqual(['[hors règle] x — nom vide — refus', '[hors règle] y — e — a']);
  });

  it('horsRegle avec echecs annoncés (tests rouges) : le warning est écrit sans empêcher le constat', async () => {
    const red: Handler = (call) => claudeOut(probeReport({ commits: [commitFile(call.opts.cwd, 'p.spec.ts', 'probe(L1): p')], echecs: ['p — borne — attendu'], horsRegle: ['q — e — a'] }));
    const h = harness({ script: { implement: [impl('a.ts')], probe: [red], fix: [impl('b.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(c.lot.warnings).toContain(`${PREFIX}q — e — a`);
    expect(kinds(h)).toContain('fix');
  });
});
