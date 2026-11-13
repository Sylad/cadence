import { retirerVariablesSession } from '../../test/variables-session.js';
import { dossierTemp } from './temp.js';

// L715 : une suite lancée depuis une session cadence run (ou une vague) hérite des variables de cette session (CADENCE_PIECES, CADENCE_CLONE…) ;
// la liste est celle de la suite racine. Les réglages de la suite (CADENCE_PLAYWRIGHT, CADENCE_TEST_*) restent.
retirerVariablesSession();

// L710 : un run s'inscrit dans le registre commun des créneaux (CADENCE_HOME) ; jamais celui de la vraie machine, où lead tour et les vagues le compteraient.
process.env.CADENCE_HOME = dossierTemp('cadence-home-');
