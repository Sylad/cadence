import { describe, expect, it } from 'vitest';
import { parseOrchestrateArgs } from '../src/orchestrate/command-args.js';
import { DOCS_GAP, droppedAddSuffix, gestureColumn, gestureSuffix, lotGesture, resumeWithoutReplay, stillRunningRefusal, withReplayHint } from '../src/orchestrate/geste.js';
import { DROPPED } from '../src/orchestrate/cycle.js';
import { renderTable } from '../src/orchestrate/table.js';
import type { LotState, WaveState } from '../src/orchestrate/state.js';

// L554 — bords : vide, absent, deux fois, mauvais type, refus, forme réelle des arguments.
const lot = (over: Partial<LotState>): LotState => ({ project: 'a', lot: 'L1', status: 'handed-back', next: null, outcome: null, steps: [], pass: 0, answers: [], questions: [], warnings: [], constats: [], proposals: [], ...over }) as unknown as LotState;
const live = { id: 'W', status: 'running' };

describe('probe L554 — resumeWithoutReplay : la commande imprimée doit se rejouer telle quelle', () => {
  it('une réponse --answer à plusieurs mots est entre guillemets (sinon le shell la coupe)', () => {
    const cmd = resumeWithoutReplay('W', ['--resume', '--wave', 'W', '--answer', 'a:L2', 'oui merci beaucoup', '--replay', 'a:L1']);
    expect(cmd).toContain('"oui merci beaucoup"');
  });
  it('un --goal à plusieurs mots est entre guillemets', () => {
    const cmd = resumeWithoutReplay('W', ['--resume', '--wave', 'W', '--goal', 'finir le lot', '--replay', 'a:L1']);
    expect(cmd).toContain('"finir le lot"');
  });
  it('--answer sans ses deux valeurs : pas de jetons vides imprimés', () => {
    const cmd = resumeWithoutReplay('W', ['--resume', '--wave', 'W', '--replay', 'a:L1', '--answer']);
    expect(cmd).not.toMatch(/ {2}|\s$/);
  });
  it('deux --replay et rien d’autre : chaîne vide', () => {
    expect(resumeWithoutReplay('W', ['--resume', '--replay', 'a:L1', '--replay', 'a:L2', '--wave', 'W'])).toBe('');
  });
  it('argv vide : chaîne vide', () => {
    expect(resumeWithoutReplay('W', [])).toBe('');
  });
  it('la commande reproduite se relit à l’identique par parseOrchestrateArgs (forme réelle)', () => {
    const argv = ['--resume', '--wave', 'W', '--replay', 'a:L1', '--drop', 'a:L2', '--budget', 'a:L3=+5000', '--continue'];
    const cmd = resumeWithoutReplay('W', argv);
    const back = parseOrchestrateArgs(cmd.replace('cadence orchestrate ', '').split(' '));
    expect(back.drop.map((d) => d.lot)).toEqual(['L2']);
    expect(back.lotBudgets).toHaveLength(1);
    expect(back.continue).toBe(true);
    expect(back.integrate).toEqual([]);
  });
});

describe('probe L554 — withReplayHint', () => {
  it('aucun refus --replay : refus inchangés, rien ajouté', () => {
    expect(withReplayHint(['claude introuvable'], 'W', ['--resume', '--drop', 'a:L1'])).toEqual(['claude introuvable']);
  });
  it('liste vide : liste vide', () => {
    expect(withReplayHint([], 'W', ['--replay', 'a:L1'])).toEqual([]);
  });
  it('un refus --replay mais seule option : pas de ligne de reprise vide', () => {
    expect(withReplayHint(['--replay a:L1 : refus'], 'W', ['--resume', '--wave', 'W', '--replay', 'a:L1'])).toEqual(['--replay a:L1 : refus']);
  });
  it('deux refus --replay : une seule ligne de reprise', () => {
    const out = withReplayHint(['--replay a:L1 : x', '--replay a:L2 : y'], 'W', ['--resume', '--wave', 'W', '--replay', 'a:L1', '--replay', 'a:L2', '--continue']);
    expect(out.filter((r) => r.includes('la reprise sans --replay'))).toHaveLength(1);
  });
});

describe('probe L554 — stillRunningRefusal', () => {
  it('aucune cible : pas de commande, pas de « : » pendu', () => {
    expect(stillRunningRefusal({ wave: 'W', pid: 7 }, [])).toBe('la vague W tourne encore (pid 7)');
  });
  it('mélange --integrate et --replay : chaque option garde son drapeau', () => {
    const r = stillRunningRefusal({ wave: 'W', pid: 7 }, [{ project: 'a', lot: 'L1' }, { project: 'a', lot: 'L2', replay: true }]);
    expect(r).toContain('--resume --wave W --integrate a:L1 --replay a:L2');
  });
  it('cible sans projet : « lot » seul', () => {
    expect(stillRunningRefusal({ wave: 'W', pid: 7 }, [{ lot: 'L1', replay: true }])).toContain('--replay L1');
  });
});

describe('probe L554 — lotGesture / suffixes', () => {
  it('statut inconnu de la vague (chaîne vide) : jamais « à la fin de la vague »', () => {
    expect(lotGesture({ id: 'W', status: '' }, lot({ next: 'review', outcome: 'x', questions: [] }))).not.toContain('à la fin');
  });
  it('un lot rendu pour docs.sync ET next=integrate : le geste docs-ok l’emporte', () => {
    expect(lotGesture(live, lot({ next: 'integrate', outcome: `${DOCS_GAP} : x` }))).toContain('raf docs-ok');
  });
  it('lot retiré : --integrate n’est jamais proposé', () => {
    expect(lotGesture(live, lot({ next: 'integrate', outcome: DROPPED }))).toBe('à la fin de la vague : cadence orchestrate a:L1');
  });
  it('lot terminé (done) avec outcome DROPPED : aucun geste', () => {
    expect(lotGesture(live, lot({ status: 'done' as LotState['status'], outcome: DROPPED }))).toBe('');
  });
  it('gestureSuffix : vide sans geste, tiret + geste sinon', () => {
    expect(gestureSuffix(live, lot({ outcome: 'revue non conforme' }))).toBe('');
    expect(gestureSuffix(live, lot({ outcome: DROPPED }))).toBe(' — le geste : à la fin de la vague : cadence orchestrate a:L1');
  });
  it('droppedAddSuffix : lot en file (sans statut) ou retiré non rendu : rien', () => {
    expect(droppedAddSuffix({}, 'a:L1')).toBe('');
    expect(droppedAddSuffix({ status: 'ready', outcome: DROPPED }, 'a:L1')).toBe('');
    expect(droppedAddSuffix({ status: 'handed-back', outcome: null }, 'a:L1')).toBe('');
    expect(droppedAddSuffix({ status: 'handed-back', outcome: DROPPED }, 'a:L1')).toContain('nouvelle vague');
  });
});

describe('probe L554 — colonne « geste » du tableau', () => {
  const wave = { id: 'W', status: 'running', budget: 1_000_000, consumed: 0, cacheRead: 0, lots: [] } as unknown as WaveState;
  const deps = { isAncestor: () => false, lotCommits: () => [], now: 0 };
  it('aucun lot : pas de colonne, pas de plantage', () => {
    expect(gestureColumn(wave, [])).toEqual({ head: [], cells: [] });
    expect(() => renderTable(wave, [], deps)).not.toThrow();
  });
  it('tableau compact (status) : la colonne geste y est aussi', () => {
    const rows = renderTable(wave, [lot({ next: 'integrate', outcome: 'x' })], { ...deps, compact: true });
    expect(rows[0]).toMatch(/\bgeste$/);
    expect(rows[1]).toContain('--integrate a:L1');
  });
  it('lignes alignées : l’en-tête « geste » commence à la même colonne que la commande', () => {
    const rows = renderTable(wave, [lot({ next: 'integrate', outcome: 'x' }), lot({ lot: 'L2', status: 'ready' })], deps);
    expect(rows[1]!.indexOf('cadence orchestrate')).toBe(rows[0]!.indexOf('geste'));
  });
  it('un lot dont la vague est suspendue : la cellule n’annonce pas « à la fin de la vague »', () => {
    const rows = renderTable({ ...wave, status: 'interrupted' } as unknown as WaveState, [lot({ next: 'review', outcome: 'x' })], deps);
    expect(rows.join('\n')).not.toContain('à la fin de la vague');
  });
});
