import { afterAll } from 'vitest';
import { cleanupTempDirs } from './helpers.js';

// Les tests de cadence vérifient eux-mêmes les refus sous CADENCE_ORCHESTRATED (deliver, raf done, orchestrate) :
// lancés depuis une session de vague, ils ne doivent pas hériter de la variable de cette session.
delete process.env.CADENCE_ORCHESTRATED;

// Les dossiers créés par tempDir() ne survivent pas à leur fichier de test (L45).
afterAll(cleanupTempDirs);
