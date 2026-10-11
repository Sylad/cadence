import { posix } from 'node:path';
import { LARGEURS } from '../spec.js';

// Briefs en aval de la fiche (L174, spec etape-spec S6) : ce que le programme dit à l'implémenteur, au relecteur de code et à la passe UX d'un lot qui a une fiche.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Une ligne par règle de la fiche : id, [état ou cas, statut], énoncé, message exact, tests prévus. Vide quand le document n'est pas une fiche. */
export function ficheRules(doc: unknown): string[] {
  if (!isObj(doc) || !Array.isArray(doc.regles)) return [];
  return doc.regles.filter(isObj).map((r) => {
    const message = typeof r.message === 'string' ? ` Message: « ${r.message} ».` : '';
    const tests = Array.isArray(r.tests) ? ` Tests: ${r.tests.map((t) => `« ${String(t)} »`).join(', ')}.` : '';
    const where = typeof r.etat === 'string' ? r.etat : Array.isArray(r.cas) ? r.cas.join(', ') : '';
    return `- ${String(r.id)} [${where ? `${where}, ` : ''}${String(r.statut)}] ${String(r.enonce ?? '').trim()}${message}${tests}`;
  });
}

/** Une ligne par contrat de la fiche back : id, appel, entrée, sortie, erreurs (code et message exact). Vide sans contrats. */
export function ficheContracts(doc: unknown): string[] {
  if (!isObj(doc) || !Array.isArray(doc.contrats)) return [];
  return doc.contrats.filter(isObj).map((c) => {
    const erreurs = Array.isArray(c.erreurs) && c.erreurs.length ? ` Errors: ${c.erreurs.filter(isObj).map((e) => `${String(e.code)} « ${String(e.message)} »`).join(', ')}.` : '';
    return `- ${String(c.id)} ${String(c.appel)} — input: ${String(c.entree ?? '').trim()}; output: ${String(c.sortie ?? '').trim()}.${erreurs}`;
  });
}

/** Le document a-t-il une partie écran (`ecran`) ? Une fiche back seule n'en a pas : ni maquette, ni captures. */
export const hasScreenPart = (doc: unknown): boolean => isObj(doc) && isObj(doc.ecran);

export type AvalKind = 'implement' | 'fix' | 'review' | 'ux';

export interface AvalOpts {
  /** Chemin (relatif au dépôt) de la fiche. */
  fiche: string;
  /** `ficheRules(doc)`. */
  rules: string[];
  /** Fichier d'acceptation du lot (chemin relatif), quand l'étape accept a eu lieu. */
  acceptation?: string;
  /** Commit rouge des tests d'acceptation, pour la revue. */
  rouge?: string;
  /** `ficheContracts(doc)` : les contrats de la partie back, vides pour une fiche d'écran seule. */
  contracts?: string[];
  /** La fiche a une partie écran (défaut : oui) ; non : une fiche back seule, sans maquette. */
  screen?: boolean;
}

/** Consigne de la fiche pour une étape en aval : `{{fiche}}` des gabarits implement, fix, review et ux. */
export function avalFicheText(kind: AvalKind, o: AvalOpts): string {
  const folder = posix.dirname(o.fiche);
  const maquette = `${folder}/maquette.html`;
  const screen = o.screen !== false;
  const contracts = o.contracts?.length ? `\nIts contracts (the calls the code must hold, with the exact codes and messages of their errors) are:\n${o.contracts.join('\n')}` : '';
  const head = screen
    ? `This lot has a screen sheet: \`${o.fiche}\` (mockup \`${maquette}\`). It is the reference of the screen; its rules are:\n${o.rules.join('\n')}${contracts}`
    : `This lot has a spec sheet: \`${o.fiche}\` (no screen: use cases, rules, contracts and data). It is the reference of the behaviour; its rules are:\n${o.rules.join('\n')}${contracts}`;
  if (kind === 'implement' || kind === 'fix') {
    return [
      head,
      kind === 'implement' ? `Read the sheet${screen ? ' and the mockup' : ''} before the first test.` : 'The sheet stays the reference of the fix: a finding that contradicts it is contested under "choix" with the rule.',
      o.acceptation
        ? `The acceptance tests are already written and committed red, from the sheet (files listed in \`${o.acceptation}\`): make them green without modifying them — the program compares them to the red commit, and a modified file hands the lot back. A change one of them needs is a question or a finding, never a silent edit.`
        : '',
      'The tests you write yourself cite the rule they cover in their name (`R2 — …`); do not invent a rule: a case the sheet does not cover is noted in your report (under "nonVerifie" or "choix"), not coded.',
      kind === 'implement' && screen ? 'The News entry ends with a `## Hypothèses` section: one line per rule whose status is `hypothese` (`- R3 — what the screen does, and what changes if it is wrong`, taken from its `si_faux`); leave it out when the sheet has no hypothesis.' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (kind === 'review') {
    return [
      head,
      'Check rule → test → green, for each rule of the sheet: its test exists (named after the rule, `R2 — …`), it is green (run it), and the behaviour it states is in the diff. The reviewer does not rebuild the cases: it holds the code against the sheet.',
      o.acceptation
        ? `The acceptance tests are listed in \`${o.acceptation}\`${o.rouge ? ` and were committed red at ${o.rouge.slice(0, 7)}` : ''}: each file must be unchanged since the red commit (\`git diff ${o.rouge ? o.rouge.slice(0, 7) : '<red commit>'} -- <file>\` is empty).`
        : 'No acceptance tests were written for this lot: the tests of the rules are the ones the implementation wrote, named after the rule (`R2 — …`).',
      o.contracts?.length ? 'Check each contract too: the code returns the output of the sheet and the exact codes and messages of its errors, and every datum the sheet announces without modification (`donnees`, `modification: aucune`) is intact. A contract that departs from the sheet is a major finding.' : '',
      'A rule without a test, an acceptance test modified since the red commit, a rule coded that is not in the sheet, and a test that is green without exercising its rule are major findings (name the rule and the file).',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `This lot has a screen sheet (\`${o.fiche}\`) and a mockup (\`${maquette}\`) that was already reviewed: this pass is a conformity pass, not the full audit. Compare the running app to the mockup, state by state (the states of the sheet), at ${LARGEURS.join(' and ')} px, against the captures \`${folder}/maquette-<état>-<largeur>.png\`.`,
    'Report the differences of rendering and ergonomics the tests do not cover (layout, spacing, hierarchy, wording on screen, contrast, focus, targets, reflow), each tied to a named rule or a measurement and to the mockup capture it differs from. Do not redo the audit of the whole screen. The rules of the sheet are covered by the tests: do not recheck them. This verdict is the input of `raf ux`, which the lead decides on the captures.',
  ].join('\n');
}
