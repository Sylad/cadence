import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tourBancLines, type StatutBanc } from '../src/bench-tour.js';
import { tempDir } from './helpers.js';

// L730 (D-22) : la garde de publication est proportionnée (banc mécanique avant une publication, banc complet le samedi) ;
// un banc complet rouge, ou un samedi manqué, se lit au tour du lead, depuis `cadence2 bench statut` du dépôt qui porte v2.
function depot(script?: string): string {
  const d = tempDir();
  if (script !== undefined) {
    mkdirSync(join(d, 'v2', 'bin'), { recursive: true });
    mkdirSync(join(d, 'v2', 'dist'), { recursive: true });
    writeFileSync(join(d, 'v2', 'bin', 'cadence2.js'), script);
    writeFileSync(join(d, 'v2', 'dist', 'cli.js'), '');
  }
  return d;
}
const STATUT = [
  'banc : dernier passage … ; garde : banc mécanique ; publication permise',
  "⚠ banc complet rouge le 2026-11-14 sur l'empreinte e1 (banc court : temps total) : ne bloque pas la publication (L903) ; à rejouer vert au banc complet du week-end : court",
  '⚠ aucun banc frais cette semaine : en ajouter avec « cadence2 bench ajouter »',
].join('\n');

describe('lead tour : l\'alerte du banc complet (L730)', () => {
  it('reprend les seules lignes ⚠ du banc complet, au nom du dépôt ; un dépôt sans v2 construit ne lance rien', () => {
    const avec = depot(''), sans = depot(), lances: string[] = [];
    const lire: StatutBanc = (cli) => { lances.push(cli); return { code: 0, sortie: STATUT }; };
    expect(tourBancLines([avec, sans], {}, lire)).toEqual([`⚠ ${basename(avec)} · banc complet rouge le 2026-11-14 sur l'empreinte e1 (banc court : temps total) : ne bloque pas la publication (L903) ; à rejouer vert au banc complet du week-end : court`]);
    expect(lances).toEqual([join(avec, 'v2', 'bin', 'cadence2.js')]);
  });
  it('rien quand le statut n\'a pas d\'alerte', () => {
    expect(tourBancLines([depot('')], {}, () => ({ code: 0, sortie: 'banc : … publication permise' }))).toEqual([]);
  });
  it('un statut illisible se voit, au lieu d\'un silence qui ressemblerait à « aucune alerte »', () => {
    const d = depot('');
    expect(tourBancLines([d], {}, () => ({ code: 1, sortie: '', erreur: 'Cannot find module dist/cli.js' }))).toEqual([`${basename(d)} · garde du banc : statut illisible (Cannot find module dist/cli.js)`]);
  });
  it('de bout en bout : lance vraiment `cadence2.js bench statut` du dépôt, avec l\'environnement du tour', () => {
    const d = depot(`if (process.argv.slice(2).join(' ') !== 'bench statut') process.exit(3);\nconsole.log(${JSON.stringify(STATUT)}.replace('e1', process.env.EMPREINTE));\n`);
    expect(tourBancLines([d], { ...process.env, EMPREINTE: 'abc' })).toEqual([`⚠ ${basename(d)} · banc complet rouge le 2026-11-14 sur l'empreinte abc (banc court : temps total) : ne bloque pas la publication (L903) ; à rejouer vert au banc complet du week-end : court`]);
    const casse = depot('process.exit(4)');
    expect(tourBancLines([casse], process.env)).toEqual([`${basename(casse)} · garde du banc : statut illisible (code 4)`]);
  });
});
