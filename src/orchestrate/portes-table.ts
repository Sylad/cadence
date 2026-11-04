import type { LotState } from './state.js';

/** Les lignes de détail des portes de tests d'un lot (L590, R10) : une par porte, avec sa portée, ses fichiers (ciblée), son code et sa durée ; vide sans portes (état écrit avant L590 compris). */
export function porteLines(l: Pick<LotState, 'project' | 'lot' | 'portes'>): string[] {
  return (l.portes ?? []).map((p) => {
    const ciblee = p.portee === 'ciblee';
    const duree = String(p.duree).replace('.', ',');
    return `${l.project}:${l.lot} — porte ${ciblee ? 'ciblée' : 'complète'} : ${ciblee ? `${p.fichiers.length} fichier(s), ` : ''}code ${p.code}, ${duree} s${p.motif ? ` (${p.motif})` : ''}`;
  });
}
