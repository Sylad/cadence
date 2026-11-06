import { configDefaults, defineWorkspace } from 'vitest/config';
import base from './vitest.config.js';

// L583 : deux projets. Les tests « lourds » (probe-L539-bords, mise-en-service L195) lancent des dépôts git et des installations : mesurés
// par L579, 2 à 3 s seuls et 12 à 13 s sous une charge moyenne de 127, quand le reste de la suite les dispute au même moment. Ils sont joués
// après les autres, dans un seul fork : vitest 2 joue d'abord les fichiers des projets multi-forks, puis ceux d'un projet à singleFork, l'un après l'autre
// dans un même processus (pool forks, resolveConfig) ; il n'y a pas de groupOrder dans cette version. `npx vitest run` joue les deux projets : la porte, le clone neuf et la CI sans option.
// L630 : les tests de signal de verify et de verify-gate (13 fichiers, dont porte-deportee-creneau-l624) lancent des processus et des délais au mur ;
// instables sous charge sur sept lots (L505 L528 L540 L550 L555 L567 L579), ils rejoignent le projet au lieu d'un correctif par test.
const signalVerify = [
  'test/porte-deportee-creneau-l624.test.ts',
  'test/verify-gate-reads-plan-detect.test.ts',
  'test/verify-gate-reads-plan-edges.test.ts',
  'test/verify-gate-reads-plan-narrow-probe.test.ts',
  'test/verify-gate-reads-plan-narrow.test.ts',
  'test/verify-gate-reads-plan.test.ts',
  'test/verify-gate-recorded.test.ts',
  'test/verify-gate.test.ts',
  'test/verify-journal-limites.test.ts',
  'test/verify-journal-local.test.ts',
  'test/verify-journal.test.ts',
  'test/verify-target.test.ts',
  'test/verify.test.ts',
];
const lourds = ['test/probe-L539-bords.test.ts', 'test/mise-en-service.test.ts', ...signalVerify];

// Les projets reprennent le réglage de vitest.config.ts (tsconfigRaw L445, délais L150, setup, bornes de workers L350) sans l'étendre :
// un projet qui étend rejoue le globalSetup, qui crée et détruit la racine temporaire de la suite, une fois par projet (le second voit le TMPDIR du premier et refuse de supprimer).
// Le globalSetup reste porté une seule fois, par la config racine.
const { globalSetup: _racine, ...test } = base.test!;
const commun = { esbuild: base.esbuild };

export default defineWorkspace([
  {
    ...commun,
    test: {
      ...test,
      name: 'principal',
      // plugins/ : mods Claude Code, testés par `claude plugin test`, pas par vitest
      exclude: [...configDefaults.exclude, 'plugins/**', ...lourds],
    },
  },
  {
    ...commun,
    test: {
      ...test,
      name: 'lourds',
      include: lourds,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
