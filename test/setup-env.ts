import { afterAll } from 'vitest';
import { cleanupTempDirs, tempDir } from './helpers.js';
import { retirerVariablesSession } from './variables-session.js';

// Les tests de cadence vérifient eux-mêmes les refus sous CADENCE_ORCHESTRATED (deliver, raf done, orchestrate) :
// lancés depuis une session de vague, ils ne doivent pas hériter de la variable de cette session.
// L715 : de même pour les autres variables qu'une session de cadence pose pour elle-même (liste dans variables-session.ts) ;
// jamais les réglages de la suite (CADENCE_PLAYWRIGHT, CADENCE_TEST_*).
retirerVariablesSession();

// Les dossiers créés par tempDir() ne survivent pas à leur fichier de test (L45).
afterAll(cleanupTempDirs);

// Le registre des vagues et les créneaux de sessions (L71) sont communs à tout l'utilisateur : jamais ceux de la
// vraie machine, où une vague peut tourner.
process.env.CADENCE_HOME = tempDir();
