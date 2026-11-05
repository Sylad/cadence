import { type LotState } from '../state.js';
import { withoutLine } from './shared.js';

/**
 * Les mineurs confiés à la passe des mineurs ont pu être proposés par une revue non conforme antérieure : si la revue qui la suit est
 * conforme, ils sont traités et ne restent pas en propositions (ceux que cette revue signale encore sont ajoutés juste après).
 * `minorPass` : la passe des mineurs est demandée par la revue qui vient d'être lue (alors rien n'est encore traité).
 */
export function settleMinorProposals(l: LotState, minorPass: boolean, conforme: boolean): void {
  if (!l.minorPass || minorPass || !conforme || !l.minorLines?.length) return;
  // Chaque mineur confié retire UNE proposition : la même ligne d'abord, sinon une de même fichier et même texte (le correctif a pu décaler la ligne).
  // Un autre mineur de même fichier et même texte, à une autre ligne, reste donc proposé. Limite connue : un texte reformulé n'est pas reconnu et reste proposé.
  const left = [...l.proposals];
  const take = (match: (p: string) => boolean) => {
    const i = left.findIndex(match);
    if (i >= 0) left.splice(i, 1);
    return i >= 0;
  };
  const rest = l.minorLines.filter((m) => !take((p) => p === m));
  for (const m of rest) take((p) => withoutLine(p) === withoutLine(m));
  l.proposals = left;
  l.minorLines = [];
}
