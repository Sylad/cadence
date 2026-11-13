import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { garderRapport, lireFlux } from '../src/rapport.js';
import { executerRun } from '../src/run/run.js';
import { commite, depot, io } from './run-outils.js';

// Issue #57 du compte pro (13-11) : un run --fond fini « integre » n'a gardé, dans son journal et son état, que le dernier message de la session, une réponse
// à une notification de tâche arrivée après le rapport ; le rapport (commits, tests scellés à resceller, vérifié / non vérifié) n'était plus que dans le transcript.
const RAPPORT = 'fini. Commits : 1a2b3c4 (issue #57). Tests scellés à resceller : test/x.test.ts. Vérifié : suite verte. Non vérifié : la capture. Hypothèse : aucune.';
const NOTE = 'Noté : l\'agent de fond a terminé, son résultat ne change rien.';
const ligne = (o: object) => JSON.stringify(o);
const assistant = (id: string, ...content: object[]) => ligne({ type: 'assistant', message: { id, role: 'assistant', content } });
const texte = (text: string) => ({ type: 'text', text }), outil = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'git commit' } });
const notification = ligne({ type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' } });
const resultat = (session: string, result: string, cout: number) => ligne({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: cout, result });

/** Ce que claude -p --output-format stream-json --verbose écrit : travail, rapport, puis un tour de plus ouvert par une notification arrivée en retard. */
const fluxIssue57 = (session: string) => [
  ligne({ type: 'system', subtype: 'init', session_id: session }),
  assistant('m1', texte('Je commite.'), outil('t1')),
  ligne({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  assistant('m2', texte(RAPPORT)),
  resultat(session, RAPPORT, 1.5),
  notification,
  assistant('m3', texte(NOTE)),
  resultat(session, NOTE, 1.7),
].join('\n');

describe('cadence run garde le rapport de fin de travail (issue #57)', () => {
  it('une notification arrivée après le rapport ne le remplace ni dans le journal ni dans l\'état', () => {
    const repo = depot(), { l, out } = io(), appels: string[][] = [];
    const exec: Executeur = (args, o) => { appels.push(args); commite('fait.txt')(o.cwd); const i = args.indexOf('--session-id'); return { stdout: fluxIssue57(args[i + 1]), code: 0 }; };
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out });
    expect(e.etat).toBe('integre');
    expect(appels[0]).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose']));
    const etat = JSON.parse(readFileSync(e.fichier, 'utf8'));
    expect(etat.rapport).toBe(RAPPORT);
    expect(etat.messages).toEqual([{ texte: RAPPORT, notification: false }, { texte: NOTE, notification: true }]);
    expect(etat.cout_usd).toBeCloseTo(1.7);
    const journal = l.join('\n');
    expect(journal).toContain(`session, rapport : ${RAPPORT}`);
    expect(journal).toMatch(/session, après le rapport \(réponse à une notification de tâche, le rapport reste celui ci-dessus\) : Noté/);
    expect(journal.indexOf(RAPPORT)).toBeLessThan(journal.indexOf(NOTE));
  });

  it('une notification pendant le travail : le rapport est le message « fini » qui suit, pas l\'attente qui précède', () => {
    const flux = [assistant('a', texte('Agent lancé en fond, j\'attends son résultat.')), notification, assistant('b', outil('t')), assistant('c', texte(RAPPORT)),
      notification, assistant('d', texte(NOTE)), resultat('s', NOTE, 1)].join('\n');
    const e: { rapport?: string } = {};
    const { messages } = lireFlux(flux);
    expect(messages.map((m) => m.notification)).toEqual([false, true, true]);
    const lignes: string[] = [];
    garderRapport(e, messages, (x) => lignes.push(x));
    expect(e.rapport).toBe(RAPPORT);
    expect(lignes[1]).toMatch(/après le rapport.*Noté/);
  });

  it('un message en plusieurs événements (un par bloc, même id) : il finit le tour seulement sans appel d\'outil ; « défini » n\'est pas « fini »', () => {
    const flux = [assistant('a', texte('Le type est défini.')), assistant('a', outil('t')), assistant('b', texte('Le type est défini, voilà.')), resultat('s', 'x', 0)].join('\n');
    expect(lireFlux(flux).messages).toEqual([{ texte: 'Le type est défini, voilà.', notification: false }]);
  });

  it('la sortie json d\'avant (un seul objet) se lit encore : un message, celui du result', () => {
    expect(lireFlux(ligne({ session_id: 's', result: 'fini', total_cost_usd: 0 }))).toMatchObject({ fin: { session_id: 's' }, messages: [{ texte: 'fini', notification: false }] });
  });
});
