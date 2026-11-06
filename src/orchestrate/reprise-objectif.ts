import { launchScreen } from './cycle/retreci.js';
import { projectEnv, specFlags } from './preflight.js';
import { lotKey, type LotState } from './state.js';

/**
 * L657 (issue #44) : l'objectif en vigueur d'un lot rejoué par `--resume`. Le dernier geste explicite gagne : la clé `goal:` du plan, non vide, qui diffère de celle que l'état a mémorisée au lancement ou à l'ajout
 * (`planGoal`) remplace `goal` — même sur un `--goal` de lancement ou d'`--add` — et devient le `planGoal` ; sinon le goal de l'état est gardé. Un état d'avant L657 n'a pas de `planGoal` : le plan est alors comparé à son `goal`.
 * Un lot sans étape jouée redécide sa spec et sa maquette avec le nouvel objectif (`launchScreen`) ; un lot déjà démarré ne gagne ni ne perd d'étape. Un plan illisible ou sans le lot garde l'objectif de l'état.
 * Rend la ligne de journal « objectif changé », ou null quand rien ne change.
 */
export function relitObjectif(l: LotState): string | null {
  const k = lotKey(l.project, l.lot);
  try {
    const env = projectEnv(l.repo);
    const plan = env.loadPlan();
    const planLot = plan.lots().find((x) => x.id === l.lot);
    const wanted = planLot?.goal?.trim() ?? '';
    if (!planLot || wanted === '' || wanted === (l.planGoal ?? l.goal ?? '')) return null;
    const old = l.goal ?? l.title;
    l.goal = wanted;
    l.planGoal = wanted;
    if (l.steps.length === 0) {
      const { screen, skipped } = launchScreen(plan, l.repo, env.config, planLot, wanted);
      const launched = skipped ? { ...planLot, spec: false } : planLot;
      delete l.screen;
      delete l.specLot;
      delete l.revueLot;
      Object.assign(l, screen ? { screen } : {}, specFlags(launched, screen, planLot.revue));
    }
    return `${k} : objectif changé : « ${old} » → « ${wanted} » (clé goal: du plan)`;
  } catch {
    // R10 : un plan illisible ou une config illisible ne refuse pas la reprise ; l'objectif de l'état reste.
    return null;
  }
}

/** `relitObjectif` de chaque lot rejoué, la ligne de journal de chaque objectif changé donnée à `say`. */
export function relitObjectifs(lots: LotState[], say: (line: string) => void): void {
  for (const l of lots) {
    const line = relitObjectif(l);
    if (line) say(line);
  }
}
