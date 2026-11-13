import { dossierTemp } from './temp.js';

// L715 : une suite lancée depuis une session cadence run (ou une vague) hérite de ses CADENCE_* (CADENCE_PIECES, CADENCE_CLONE…) ;
// aucun test ne les reçoit de l'appelant : celui qui lit une CADENCE_* la pose lui-même (vi.stubEnv). Restent les CADENCE_TEST_*, réglages de la suite (racine : global-setup.ts).
for (const k of Object.keys(process.env)) if (k.startsWith('CADENCE_') && !k.startsWith('CADENCE_TEST_')) delete process.env[k];

// L710 : un run s'inscrit dans le registre commun des créneaux (CADENCE_HOME) ; jamais celui de la vraie machine, où lead tour et les vagues le compteraient.
process.env.CADENCE_HOME = dossierTemp('cadence-home-');
