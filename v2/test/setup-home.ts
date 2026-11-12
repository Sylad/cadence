import { dossierTemp } from './temp.js';

// L710 : un run s'inscrit dans le registre commun des créneaux (CADENCE_HOME) ; jamais celui de la vraie machine, où lead tour et les vagues le compteraient.
process.env.CADENCE_HOME = dossierTemp('cadence-home-');
