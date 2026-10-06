import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { cleanupTempDirs } from './helpers.js';

// Les tests de cadence vérifient eux-mêmes les refus sous CADENCE_ORCHESTRATED (deliver, raf done, orchestrate) :
// lancés depuis une session de vague, ils ne doivent pas hériter de la variable de cette session.
delete process.env.CADENCE_ORCHESTRATED;

// Les dossiers créés par tempDir() ne survivent pas à leur fichier de test (L45).
afterAll(cleanupTempDirs);

// Le registre des vagues et les créneaux de sessions (L71) sont communs à tout l'utilisateur : jamais ceux de la
// vraie machine, où une vague peut tourner.
process.env.CADENCE_HOME = mkdtempSync(join(tmpdir(), 'cadence-home-'));
afterAll(() => rmSync(process.env.CADENCE_HOME!, { recursive: true, force: true }));
