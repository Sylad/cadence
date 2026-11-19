// L784 (porte rouge du 19-11) : la sonde ferme elle-même son ancienne page à chaque réouverture. Une navigation dans le même document (le lien `#x`
// que l'essai large clique) relançait la lecture du marqueur ; la fermeture la faisait échouer (cible fermée) et la page de la sonde était dite
// « fenêtre fermée avant que la sonde ait pu y lire le marqueur ». avantFermeture finit la lecture d'abord ; une page sans marqueur reste dite non gardée.
// Faux contexte Playwright : une lecture en cours rejette quand la page se ferme, comme frame.evaluate.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { surveillerFenetres } from '../scripts/sondes-garde.mjs';

const MARQUE = (tot: boolean) => ({ tot });

function fausseFenetre(marque: { tot: boolean } | null, url = 'http://h/p.html#x') {
  const page = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let fermee = false;
  const enAttente = new Set<(e: Error) => void>();
  const frame = {
    url: () => url,
    isDetached: () => fermee,
    // La lecture répond au bout de 20 ms ; une fermeture avant la fait rejeter, une lecture lancée sur une page fermée rejette aussitôt.
    evaluate: () => new Promise((ok, ko) => { if (fermee) return ko(new Error('Target closed')); enAttente.add(ko); setTimeout(() => { enAttente.delete(ko); if (!fermee) ok(marque); }, 20); }),
  };
  Object.assign(page, {
    mainFrame: () => frame, frames: () => (fermee ? [] : [frame]), isClosed: () => fermee,
    close: () => { fermee = true; for (const ko of enAttente) ko(new Error('Target closed')); enAttente.clear(); page.emit('close'); },
  });
  const contexte = Object.assign(new EventEmitter(), { pages: () => [page] });
  return { page, frame, contexte };
}

describe('surveillerFenetres : la sonde qui ferme sa propre page attend sa lecture du marqueur (L784)', () => {
  it('navigation #x puis fermeture par la sonde après avantFermeture : rien n\'est dit', async () => {
    const { page, frame, contexte } = fausseFenetre(MARQUE(true));
    const fenetres: string[] = [];
    const s = surveillerFenetres(contexte, fenetres);
    await new Promise((r) => setTimeout(r, 40)); // première lecture faite
    page.emit('framenavigated', frame); // #x : lecture relancée
    await s.avantFermeture(page);
    (page.close as () => void)();
    await new Promise((r) => setTimeout(r, 40));
    expect(fenetres).toEqual([]);
  });

  it('sans avantFermeture, la même fermeture fait échouer la lecture et la page est dite fermée avant lecture (la course de la porte rouge)', async () => {
    const { page, frame, contexte } = fausseFenetre(MARQUE(true));
    const fenetres: string[] = [];
    surveillerFenetres(contexte, fenetres);
    await new Promise((r) => setTimeout(r, 40));
    page.emit('framenavigated', frame);
    (page.close as () => void)();
    await new Promise((r) => setTimeout(r, 40));
    expect(fenetres).toEqual(['http://h/p.html#x : fenêtre fermée avant que la sonde ait pu y lire le marqueur du script d\'initialisation']);
  });

  it('une page sans marqueur reste dite non gardée, avantFermeture ou pas', async () => {
    const { page, contexte } = fausseFenetre(null);
    const fenetres: string[] = [];
    const s = surveillerFenetres(contexte, fenetres);
    await s.avantFermeture(page);
    (page.close as () => void)();
    await new Promise((r) => setTimeout(r, 40));
    expect(fenetres).toEqual(['http://h/p.html#x : le script d\'initialisation n\'y a pas tourné (marqueur absent)']);
  });
});
