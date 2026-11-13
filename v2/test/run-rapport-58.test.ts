import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lire, type Executeur } from '../src/bench/bras.js';
import { CONSIGNE_FINI, garderRapport, lireFlux, MARQUEUR, marque } from '../src/rapport.js';
import { cmdRun } from '../src/run/cli.js';
import { executerRun } from '../src/run/run.js';
import { commite, depot, io } from './run-outils.js';

// Issue #58 du compte pro (13-11), l'inverse de #57 : une session cadence run --fond a fini le tour du prompt sur une ligne d'attente (« La recette navigateur
// complète tourne ; je surveille les échecs et sa fin. ») ; sept tours ont suivi, chacun ouvert par une notification de tâche, et le dernier tenait le vrai
// rapport. L'état a gardé la ligne d'attente. Revue L728 : deviner le rapport à la forme du flux (outils appelés, tâches de fond actives) a cédé cinq fois
// dans la journée (M1 : un Read tardif après un rapport donné pendant qu'une tâche tournait le remplaçait ; M2 : un rapport tardif sans outil passait pour
// un run normal). Le lecteur ne devine plus : le brief demande que le rapport final commence par la ligne MARQUEUR, nulle part ailleurs ; le rapport
// retenu est le DERNIER message qui commence par elle ; sans aucun marqueur, le dernier message, et l'état, la ligne de fin et --liste disent
// « rapport sans marqueur : à vérifier dans le journal ».
// flux-attente-tache-de-fond : vrai `claude -p --output-format stream-json --verbose --model haiku` (2.1.293, 13-11), une suite lancée en fond, une ligne
// d'attente, puis au tour 2 la sortie lue (Read), écrite (Bash) et le rapport ; seuls les événements hook et init (réduits) et les chemins ont été retouchés.
// Les deux vrais flux datent d'avant la consigne : ils n'ont pas de marqueur. `marquer` le met dans le message qu'une session qui suit le brief aurait marqué.
const fixture = (nom: string) => readFileSync(join(import.meta.dirname, 'fixtures', nom), 'utf8');
const ATTENTE = fixture('flux-attente-tache-de-fond-2.1.293.jsonl');
const TARDIVE = fixture('flux-notification-tardive-2.1.293.jsonl'); // #57 : rapport au tour 1, tour 2 qui ne fait que répondre à la notification
const LIGNE_ATTENTE = 'La suite tourne ; je surveille sa fin.';
const RAPPORT = 'Rapport : la suite est terminée avec le code de sortie 0. Sa sortie, lue avec l\'outil Read, est « suite: 12 tests verts ». Elle est écrite dans '
  + '`resultat.txt`, dans le dossier scratchpad de la session, et le fichier relu contient bien cette ligne.';
const FINI_57 = 'fini, commande lancée en fond.', TARD_57 = 'Fini : la commande en arrière-plan a bien terminé avec le code de sortie 0.';
const SANS = 'rapport sans marqueur : à vérifier dans le journal';
/** Le même flux, le marqueur en tête du message `texte` (bloc text et result, encodés JSON). */
const marquer = (flux: string, texte: string) => flux.replaceAll(JSON.stringify(texte).slice(1, -1), JSON.stringify(`${MARQUEUR}\n${texte}`).slice(1, -1));
const ATTENTE_MARQUE = marquer(ATTENTE, RAPPORT), TARDIVE_MARQUE = marquer(TARDIVE, FINI_57);

const ligne = (o: object) => JSON.stringify(o);
const assistant = (id: string, ...content: object[]) => ligne({ type: 'assistant', message: { id, role: 'assistant', content } });
const texte = (text: string) => ({ type: 'text', text });
const outil = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name, input: {} });
const demarre = (task_id: string) => ligne({ type: 'system', subtype: 'task_started', task_id, is_backgrounded: true });
const notification = (task_id: string) => ligne({ type: 'system', subtype: 'task_notification', task_id, status: 'completed', output_file: '/tmp/b.out' });
const resultat = (result: string, cout: number, erreur = false) => ligne({ type: 'result', subtype: 'success', is_error: erreur, session_id: 's', total_cost_usd: cout, result });
const vu = (f: ReturnType<typeof lireFlux>) => f.messages.map((m) => [m.tour, m.texte.split('\n').at(-1), m.marque, m.apres]);

/** Un run complet sur `flux` (l'id de session de la fixture remplacé par celui du run) ; rend l'état relu, le journal et la sortie de --liste. */
async function jouer(flux: string, session: string) {
  const repo = depot(), { l, out } = io();
  const exec: Executeur = (args, o) => {
    commite('fait.txt')(o.cwd);
    return { stdout: flux.replaceAll(session, args[args.indexOf('--session-id') + 1]), code: 0 };
  };
  const e = executerRun({ repo, demande: 'Lance la suite en fond et rends le rapport', exec, out });
  const liste: string[] = [];
  await cmdRun(['--liste'], { cwd: repo, env: {}, out: (x) => liste.push(x), err: () => {}, now: () => new Date() });
  return { e, etat: JSON.parse(readFileSync(e.fichier, 'utf8')), journal: l.join('\n'), liste: liste.join('\n') };
}

describe('cadence run : le rapport est le dernier message qui commence par le marqueur (L728, issues #57 et #58)', () => {
  it('le marqueur : seul en tête de ligne, en première ligne du message ; « fini » ou le marqueur ailleurs ne comptent pas', () => {
    expect(MARQUEUR).toBe('=== FINI ===');
    for (const t of [MARQUEUR, `${MARQUEUR}\nRapport.`, `  ${MARQUEUR}  \nRapport.`, `\n${MARQUEUR}\n`]) expect(marque(t), t).toBe(true);
    for (const t of ['fini', 'Fini : tout est bon.', `${MARQUEUR} voilà`, `Rapport.\n${MARQUEUR}`, `Voici ${MARQUEUR}`, '=== FINI', '']) expect(marque(t), t).toBe(false);
  });

  it('vrai flux #58 marqué : le rapport est le tour 2, celui qui porte le marqueur ; la ligne d\'attente est « pendant le travail »', () => {
    const f = lireFlux(ATTENTE_MARQUE);
    expect(f.messages).toEqual([{ texte: LIGNE_ATTENTE, tour: 1 }, { texte: `${MARQUEUR}\n${RAPPORT}`, tour: 2, marque: true }]);
    expect(f.travail?.result).toBe(`${MARQUEUR}\n${RAPPORT}`);
    expect(f.apres).toBe(false);
    const e: { rapport?: string; rapport_tour?: number; rapport_sans_marqueur?: true } = {}, lignes: string[] = [];
    garderRapport(e, f.messages, (x) => lignes.push(x));
    expect(e).toEqual(expect.objectContaining({ rapport: `${MARQUEUR}\n${RAPPORT}`, rapport_tour: 2 }));
    expect(e.rapport_sans_marqueur).toBeUndefined();
    expect(lignes).toEqual([`session, pendant le travail : ${LIGNE_ATTENTE}`, `session, rapport (marqué, tour 2) : ${MARQUEUR}\n${RAPPORT}`]);
  });

  it('vrai flux #57 marqué : le rapport est le tour 1, celui qui porte le marqueur ; la réponse tardive du tour 2 est « après le rapport »', () => {
    const f = lireFlux(TARDIVE_MARQUE);
    expect(f.messages).toEqual([{ texte: `${MARQUEUR}\n${FINI_57}`, tour: 1, marque: true }, { texte: TARD_57, tour: 2, apres: true }]);
    expect(f.travail?.result).toBe(`${MARQUEUR}\n${FINI_57}`);
    expect(f.apres).toBe(true);
    const e: { rapport?: string; rapport_tour?: number } = {}, lignes: string[] = [];
    garderRapport(e, f.messages, (x) => lignes.push(x));
    expect(e).toEqual({ rapport: `${MARQUEUR}\n${FINI_57}`, rapport_tour: 1, messages: f.messages });
    expect(lignes).toEqual([`session, rapport : ${MARQUEUR}\n${FINI_57}`, `session, tour 2, après le rapport (ne change ni le rapport ni l'état du run) : ${TARD_57}`]);
  });

  it('vrais flux #58 et #57 bruts (sans marqueur) : le lecteur ne devine pas ; le dernier message est le rapport, l\'état dit qu\'il est à vérifier', () => {
    for (const [flux, dernier] of [[ATTENTE, RAPPORT], [TARDIVE, TARD_57]] as const) {
      const f = lireFlux(flux);
      expect(f.messages.every((m) => !m.marque && !m.apres)).toBe(true);
      expect(f.travail?.result).toBe(dernier);
      expect(f.apres).toBe(false);
      const e: { rapport?: string; rapport_tour?: number; rapport_sans_marqueur?: true } = {}, lignes: string[] = [];
      garderRapport(e, f.messages, (x) => lignes.push(x));
      expect(e).toEqual(expect.objectContaining({ rapport: dernier, rapport_tour: 2, rapport_sans_marqueur: true }));
      expect(lignes.at(-1)).toBe(`session, rapport (sans marqueur : le dernier message de la session, à vérifier) : ${dernier}`);
    }
  });

  // Revue L728, M1 : avec la règle « tour de travail sans tâche active », ce flux donnait « Ok, sortie lue. » comme rapport, et le result du tour 2 décidait.
  it('M1 : rapport marqué au tour 1 pendant qu\'une tâche de fond tourne, puis un Read tardif de sa sortie : le rapport reste, le tour 2 ne décide de rien', () => {
    const rapport = `${MARQUEUR}\nRapport complet : commits, tests.`;
    const flux = [assistant('a', outil('t1')), demarre('b'), assistant('b', texte(rapport)), resultat(rapport, 1), notification('b'),
      assistant('c', outil('t2', 'Read')), assistant('d', texte('Ok, sortie lue.')), resultat('Ok, sortie lue.', 1.1, true)].join('\n');
    const f = lireFlux(flux);
    expect(vu(f)).toEqual([[1, 'Rapport complet : commits, tests.', true, undefined], [2, 'Ok, sortie lue.', undefined, true]]);
    expect(f.travail?.result).toBe(rapport);
    expect(lire({ stdout: flux, code: 1 })).toMatchObject({ echec: null, resultat: rapport, cout: 1.1 }); // ni l'erreur ni le code du tour tardif
  });

  // Revue L728, M2 : ce flux a la forme de #57 ; la règle d'avant gardait « J'attends. » et disait « tour 1, celui du prompt », comme un run normal.
  it('M2 : ligne d\'attente au tour 1, rapport marqué dans un tour tardif sans outil : le rapport est celui du tour 2', () => {
    const rapport = `${MARQUEUR}\nRapport final.`;
    const flux = [assistant('a', outil('t1')), demarre('b'), assistant('b', texte('J\'attends.')), resultat('J\'attends.', 1), notification('b'),
      assistant('c', texte(rapport)), resultat(rapport, 1.1)].join('\n');
    const f = lireFlux(flux);
    expect(vu(f)).toEqual([[1, 'J\'attends.', undefined, undefined], [2, 'Rapport final.', true, undefined]]);
    expect(f.travail?.result).toBe(rapport);
    expect(f.apres).toBe(false);
  });

  it('plusieurs marqueurs : le dernier gagne ; ce qui suit le dernier, dans son tour ou un tour suivant, est « après le rapport »', () => {
    const flux = [assistant('a', texte(`${MARQUEUR}\nPremier.`)), resultat('Premier.', 1), notification('b1'), assistant('b', outil('t')),
      assistant('c', texte(`${MARQUEUR}\nSecond.`)), assistant('d', outil('t2')), assistant('e', texte('Encore un mot.')), resultat('Encore un mot.', 1.1),
      notification('b2'), assistant('f', texte('Rien.')), resultat('Rien.', 1.2)].join('\n');
    const f = lireFlux(flux);
    expect(vu(f)).toEqual([[1, 'Premier.', true, undefined], [2, 'Second.', true, undefined], [2, 'Encore un mot.', undefined, true], [3, 'Rien.', undefined, true]]);
    expect(f.travail?.total_cost_usd).toBe(1.1);
    expect(f.fin?.total_cost_usd).toBe(1.2);
    const e: { rapport?: string; rapport_tour?: number } = {};
    garderRapport(e, f.messages, () => {});
    expect(e).toMatchObject({ rapport: `${MARQUEUR}\nSecond.`, rapport_tour: 2 });
  });

  it('sans marqueur, le dernier tour décide : une session coupée pendant un tour qui suit l\'attente est un échec, jamais la ligne d\'attente comme rapport', () => {
    const coupe = ATTENTE.split('\n').filter(Boolean);
    const avant = coupe.slice(0, coupe.findIndex((l) => l.includes('"name":"Read"')) + 1).join('\n');
    expect(lire({ stdout: avant, code: 143, erreur: 'SIGTERM' }).echec).toBe(`session arrêtée avant son result (SIGTERM) ; dernier message : ${LIGNE_ATTENTE}`);
    const quota = 'You\'ve hit your weekly limit · resets Thu 9am (Europe/Paris)'; // sans marqueur, un quota au dernier tour compte
    expect(lire({ stdout: [assistant('a', texte('J\'attends.')), resultat('J\'attends.', 1), notification('b'), resultat(quota, 1.1, true)].join('\n'), code: 1 }).echec)
      .toMatch(/^session s : erreur \(« You've hit your weekly limit/);
  });

  it('run sur le vrai flux #58 marqué : état, journal, ligne de fin et --liste disent le rapport marqué du tour 2', async () => {
    const r = await jouer(ATTENTE_MARQUE, 'e4e9732e-b2c0-4da2-83f5-8a01af4a3c8f');
    expect(r.e.etat).toBe('integre');
    expect(r.etat).toMatchObject({ rapport: `${MARQUEUR}\n${RAPPORT}`, rapport_tour: 2 });
    expect(r.etat.rapport_sans_marqueur).toBeUndefined();
    expect(r.journal).toContain(`session, pendant le travail : ${LIGNE_ATTENTE}`);
    expect(r.journal).toMatch(/cadence run \S+ : integre \(main = \w+\) · \d+ s · [\d.]+ \$ · rapport marqué, tour 2$/m);
    expect(r.liste).toContain('  · rapport marqué, tour 2');
  });

  it('run sur le vrai flux #57 marqué : le rapport est celui du tour 1, la réponse tardive au journal seulement', async () => {
    const r = await jouer(TARDIVE_MARQUE, '4ac4aee7-0d65-49a0-b15d-51761b43a6a8');
    expect(r.etat).toMatchObject({ rapport: `${MARQUEUR}\n${FINI_57}`, rapport_tour: 1 });
    expect(r.journal).toContain(`session, tour 2, après le rapport (ne change ni le rapport ni l'état du run) : ${TARD_57}`);
    expect(r.journal).toMatch(/ \$ · rapport marqué, tour 1$/m);
    expect(r.liste).toContain('  · rapport marqué, tour 1');
  });

  it('run sur les vrais flux bruts (sans marqueur) : l\'état, la ligne de fin et --liste disent « rapport sans marqueur : à vérifier dans le journal »', async () => {
    for (const [flux, session, dernier] of [[ATTENTE, 'e4e9732e-b2c0-4da2-83f5-8a01af4a3c8f', RAPPORT], [TARDIVE, '4ac4aee7-0d65-49a0-b15d-51761b43a6a8', TARD_57]] as const) {
      const r = await jouer(flux, session);
      expect(r.e.etat).toBe('integre');
      expect(r.etat).toMatchObject({ rapport: dernier, rapport_tour: 2, rapport_sans_marqueur: true });
      expect(r.journal).toMatch(new RegExp(` \\$ · ${SANS}$`, 'm'));
      expect(r.journal).toContain(`session, rapport (sans marqueur : le dernier message de la session, à vérifier) : ${dernier}`);
      expect(r.liste).toContain(`  · ${SANS}`);
    }
  });

  it('les briefs de cadence run et les consignes de reprise demandent le marqueur, en tête du rapport et nulle part ailleurs', () => {
    for (const b of ['bras-A.md', 'bras-sequence-v2d.md']) {
      const l = readFileSync(join(import.meta.dirname, '..', 'briefs', b), 'utf8').split('\n').filter((x) => x.includes(MARQUEUR));
      expect(l, b).toHaveLength(1);
      expect(l[0]).toMatch(/^- Dis ensuite « fini » : un seul message, qui commence par la ligne « === FINI === » \(seule sur sa ligne\)/);
      expect(l[0]).toContain('ne l\'écris nulle part ailleurs, ni dans une ligne d\'attente, ni dans une réponse à une notification de tâche');
      expect(l[0]).toContain('ce que tu as vérifié et ce que tu n\'as pas vérifié');
    }
    expect(CONSIGNE_FINI).toContain(`« ${MARQUEUR} »`);
    const run = readFileSync(join(import.meta.dirname, '..', 'src', 'run', 'run.ts'), 'utf8');
    expect(run).not.toMatch(/dis « fini »/); // quota, bascule, conflit, correction : la même consigne, par CONSIGNE_FINI
    expect(run.match(/\$\{CONSIGNE_FINI\}/g)).toHaveLength(4);
  });
});
