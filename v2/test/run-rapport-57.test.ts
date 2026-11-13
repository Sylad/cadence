import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lire, type Executeur } from '../src/bench/bras.js';
import { garderRapport, lireFlux } from '../src/rapport.js';
import { executerRun } from '../src/run/run.js';
import { commite, depot, io } from './run-outils.js';

// Issue #57 du compte pro (13-11) : un run --fond fini « integre » n'a gardé, dans son journal et son état, que le dernier message de la session, une réponse
// à une notification de tâche arrivée après le rapport ; le rapport (commits, tests scellés à resceller, vérifié / non vérifié) n'était plus que dans le transcript.
// Les flux sont capturés de vrais `claude -p --output-format stream-json --verbose --model haiku` (2.1.293, 13-11) ; seuls l'événement init (réduit à
// quelques champs) et les chemins ont été retouchés. La notification y est un événement system/task_notification, jamais un message user.
const fixture = (nom: string) => readFileSync(join(import.meta.dirname, 'fixtures', nom), 'utf8');
const TARDIVE = fixture('flux-notification-tardive-2.1.293.jsonl');
const PENDANT = fixture('flux-notification-pendant-le-travail-2.1.293.jsonl');

const ligne = (o: object) => JSON.stringify(o);
const assistant = (id: string, ...content: object[]) => ligne({ type: 'assistant', message: { id, role: 'assistant', content } });
const texte = (text: string) => ({ type: 'text', text });
const outil = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'git commit' } });
const notification = ligne({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'Background command completed' });
const resultat = (session: string, result: string, cout: number, erreur = false) =>
  ligne({ type: 'result', subtype: 'success', is_error: erreur, session_id: session, total_cost_usd: cout, result });
const RAPPORT = 'fini. Commits : 1a2b3c4 (issue #57). Tests scellés à resceller : test/x.test.ts. Vérifié : suite verte. Non vérifié : la capture.';
const TARD = 'Notification tardive : rien de neuf, le rapport « fini » reste valable.';

describe('cadence run garde le rapport de fin de travail (issue #57)', () => {
  it('vrai flux : la réponse tardive, qui dit « Fini », reste au tour 2 ; le rapport est le message du tour du prompt', () => {
    const f = lireFlux(TARDIVE);
    expect(f.messages).toEqual([
      { texte: 'fini, commande lancée en fond.', tour: 1 },
      { texte: 'Fini : la commande en arrière-plan a bien terminé avec le code de sortie 0.', tour: 2 },
    ]);
    expect(f.travail?.result).toBe('fini, commande lancée en fond.');
    expect(f.fin?.total_cost_usd).toBeGreaterThan(f.travail?.total_cost_usd ?? Infinity); // le dernier result cumule
    expect(f.apres).toBe(true);
  });

  it('vrai flux : une notification pendant le travail ne change pas le tour ; le rapport est celui du tour 1, la réponse tardive va au tour 2', () => {
    const { messages } = lireFlux(PENDANT);
    expect(messages).toEqual([
      { texte: 'fini, trois commandes lancées.', tour: 1 },
      { texte: 'fini : la commande « tardif » en arrière-plan s\'est terminée avec le code 0.', tour: 2 },
    ]);
    const e: { rapport?: string } = {}, lignes: string[] = [];
    garderRapport(e, messages, (x) => lignes.push(x));
    expect(e.rapport).toBe('fini, trois commandes lancées.');
    expect(lignes).toEqual([
      'session, rapport : fini, trois commandes lancées.',
      'session, tour 2, après le rapport (notification de tâche ; ne change ni le rapport ni l\'état du run) : fini : la commande « tardif » en arrière-plan s\'est terminée avec le code 0.',
    ]);
  });

  it('run sur le vrai flux : le journal écrit tous les messages, dans l\'ordre ; l\'état garde le rapport, les messages et le coût cumulé', () => {
    const repo = depot(), { l, out } = io(), appels: string[][] = [];
    const exec: Executeur = (args, o) => {
      appels.push(args);
      commite('fait.txt')(o.cwd);
      const i = args.indexOf('--session-id');
      return { stdout: TARDIVE.replaceAll('4ac4aee7-0d65-49a0-b15d-51761b43a6a8', args[i + 1]), code: 0 };
    };
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out });
    expect(e.etat).toBe('integre');
    expect(appels[0]).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose']));
    const etat = JSON.parse(readFileSync(e.fichier, 'utf8'));
    expect(etat.rapport).toBe('fini, commande lancée en fond.');
    expect(etat.messages.map((m: { tour: number }) => m.tour)).toEqual([1, 2]);
    expect(etat.cout_usd).toBeCloseTo(0.00773859);
    const journal = l.join('\n');
    expect(journal.indexOf('session, rapport : fini, commande lancée en fond.')).toBeGreaterThan(-1);
    expect(journal.indexOf('session, rapport : fini')).toBeLessThan(journal.indexOf('session, tour 2, après le rapport'));
  });

  it('un message « fini » pendant le travail, un appel d\'outil, puis le rapport : tous au journal, le rapport est le dernier du tour 1', () => {
    const flux = [assistant('a', texte('Agent lancé, fini pour cette étape.')), notification, assistant('b', outil('t')), assistant('c', texte(RAPPORT)),
      resultat('s', RAPPORT, 1), notification, assistant('d', texte(TARD)), resultat('s', TARD, 1.2)].join('\n');
    const e: { rapport?: string } = {}, lignes: string[] = [];
    garderRapport(e, lireFlux(flux).messages, (x) => lignes.push(x));
    expect(e.rapport).toBe(RAPPORT);
    expect(lignes).toEqual([
      'session, pendant le travail : Agent lancé, fini pour cette étape.',
      `session, rapport : ${RAPPORT}`,
      `session, tour 2, après le rapport (notification de tâche ; ne change ni le rapport ni l'état du run) : ${TARD}`,
    ]);
  });

  it('un tour tardif ne décide plus de la session : ni son erreur, ni son code de sortie, ni son texte de quota ; le coût reste le dernier', () => {
    const quota = 'You\'ve hit your limit · resets 6pm (Europe/Paris)';
    const flux = [assistant('a', texte(RAPPORT)), resultat('s', RAPPORT, 1), notification, assistant('b', texte(quota)), resultat('s', quota, 1.1, true)].join('\n');
    expect(lire({ stdout: flux, code: 1 })).toMatchObject({ echec: null, resultat: RAPPORT, session: 's', cout: 1.1 });
    const coupe = [assistant('a', texte(RAPPORT)), resultat('s', RAPPORT, 1), notification].join('\n'); // tué pendant le tour tardif, avant son result
    expect(lire({ stdout: coupe, code: 143, erreur: 'SIGTERM' }).echec).toBeNull();
    expect(lire({ stdout: [assistant('a', texte(RAPPORT)), resultat('s', RAPPORT, 1)].join('\n'), code: 1 }).echec).toBe('code 1'); // un seul tour : le code compte
  });

  it('un travail en échec reste un échec, même suivi d\'un tour réussi', () => {
    const flux = [assistant('a', texte('Erreur.')), resultat('s', 'Erreur.', 1, true), notification, assistant('b', texte(TARD)), resultat('s', TARD, 1.1)].join('\n');
    expect(lire({ stdout: flux, code: 0 }).echec).toBe('session s : success');
  });

  it('flux coupé avant tout result : ce qui a été dit est gardé au tour 1, la sortie est illisible', () => {
    const flux = [assistant('a', texte('Je commence.')), assistant('b', outil('t'))].join('\n');
    expect(lireFlux(flux)).toMatchObject({ travail: null, messages: [{ texte: 'Je commence.', tour: 1 }], apres: false });
    expect(lire({ stdout: flux, code: 143 }).echec).toMatch(/^sortie illisible/);
  });

  it('un message en plusieurs événements (un par bloc, même id) ne compte que sans appel d\'outil', () => {
    const flux = [assistant('a', texte('Je regarde.')), assistant('a', outil('t')), assistant('b', texte('Le type est défini, voilà.')), resultat('s', 'x', 0)].join('\n');
    expect(lireFlux(flux).messages).toEqual([{ texte: 'Le type est défini, voilà.', tour: 1 }]);
  });

  it('la sortie json d\'avant (un seul objet) se lit encore : un tour, son message est celui du result', () => {
    expect(lireFlux(ligne({ session_id: 's', result: 'fini', total_cost_usd: 0 }))).toMatchObject({
      travail: { session_id: 's' }, messages: [{ texte: 'fini', tour: 1 }], apres: false,
    });
  });
});
