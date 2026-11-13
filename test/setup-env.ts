import { afterAll } from 'vitest';
import { cleanupTempDirs, tempDir } from './helpers.js';

// Les tests de cadence vérifient eux-mêmes les refus sous CADENCE_ORCHESTRATED (deliver, raf done, orchestrate) :
// lancés depuis une session de vague, ils ne doivent pas hériter de la variable de cette session.
// L715 : de même pour toute CADENCE_* (CADENCE_PIECES, CADENCE_CLONE, CADENCE_BANC_RACINE d'une session cadence run, CADENCE_MAX_SESSIONS…) :
// le test qui en lit une la pose lui-même (vi.stubEnv). Restent les CADENCE_TEST_*, réglages de la suite elle-même (global-setup.ts, vitest.config.ts).
for (const k of Object.keys(process.env)) if (k.startsWith('CADENCE_') && !k.startsWith('CADENCE_TEST_')) delete process.env[k];

// Les dossiers créés par tempDir() ne survivent pas à leur fichier de test (L45).
afterAll(cleanupTempDirs);

// Le registre des vagues et les créneaux de sessions (L71) sont communs à tout l'utilisateur : jamais ceux de la
// vraie machine, où une vague peut tourner.
process.env.CADENCE_HOME = tempDir();
