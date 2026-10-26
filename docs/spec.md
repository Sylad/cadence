[← cadence](../README.md)

# spec

`cadence spec check <fiche.yaml>` checks a **sheet** (`fiche.yaml`, the machine-readable output of the spec step): a **screen sheet** (a lot with `screen:`), a **back-end sheet** (a lot that changes a behaviour without a screen) or a **mixed sheet** with both parts. The screen part is designed in
[docs/superpowers/specs/2026-10-10-etape-spec-design.md](superpowers/specs/2026-10-10-etape-spec-design.md)). Start from the template
[`templates/fiche.yaml`](../templates/fiche.yaml) (it passes the check as is), a worked example sits next to the design. It prints one
`✗ …` line per violation and exits **0** when the sheet is valid, **1** with violations, **2** when the file is missing, is not YAML or the usage is wrong. The invariants:

- `ecran` has `id`, `titre`, `route` (starts with `/`), `lot`, `maquette`, and `largeurs: [1440, 390]`; `etats` holds at least `vide`, `chargement`, `erreur`, none twice;
- `champs[]`: a unique kebab-case `id` (it is also the mockup's `data-testid`), `libelle`, `type`, `source`, and a boolean `obligatoire`;
- `regles[]` are numbered `R1`, `R2`… in order with no gap; each has an `etat` that is one of `etats`, an `enonce`, a `message` (the exact text on screen, or `null`),
  a `statut` — `sourcee` with the `source` it comes from, or `hypothese` with the `si_faux` that says what would change — and at least one planned test, named `Rn — …`;
- `masque` (optional, only on a rule of state `vide`) lists the fields the rule makes disappear: every id must be a field of the sheet and none may be one the rule shows in `champs`;
- `actions[]` are numbered `A1`… in order, their `declencheur` is a field id (or `null` for the page load), their `appel` reads `VERB /path`, and the `regles` they carry exist.

**Back-end sheet** (L187; design: [docs/superpowers/specs/2026-10-11-etape-spec-back-design.md](superpowers/specs/2026-10-11-etape-spec-back-design.md)). Start from [`templates/fiche-back.yaml`](../templates/fiche-back.yaml) (it passes the check as is); a worked example, a real lot of ol-companion, sits next to the design. The sheet has `sujet` instead of `ecran` (no `etats`, `champs`, mockup), and the same `regles`. The back-end invariants, one `✗ …` line each:

- `sujet` has `id` (kebab-case, the folder name `docs/specs/<id>/`), `titre`, `lot`, and a `perimetre` with `modules`, `endpoints` and `jobs` (lists of texts, at least one entry in the three) and an optional `hors_perimetre`;
- `cas[]` are numbered `C1`, `C2`… with no gap, each with `titre`, `acteur`, `declencheur`, `preconditions`, `nominal` (a non-empty list of steps), `resultat`, and `alternatives` — a list of `{ si, alors, regles }`, each citing at least one existing rule — or `alternatives: []` with its reason in `sans_alternative`; every case is cited by at least one rule;
- a back-end rule has `cas` (at least one existing case id) instead of `etat`, plus the screen rule's `enonce`, `statut` (`sourcee` + `source`, or `hypothese` + `si_faux`) and tests named `Rn — …`; `message`, `champs` and `masque` only make sense on a rule attached to a state;
- `contrats[]` are numbered `A1`… with no gap, each with an `appel` (`VERB /path`, `job <name>` or `commande <name>`), `entree`, `sortie`, `erreurs` — a list of `{ code, message }` where `code` is `HTTP <n>` or `log debug|log|warn|warning|error|info|critical|fatal|verbose` and `message` the exact text — or `erreurs: []` with its reason in `sans_erreur`, and the `regles` it carries exist;
- `donnees[]` are numbered `D1`…, each with `objet`, `note`, a boolean `existant` and a `modification` (`aucune`, `ajout` or `changement`); an existing object that is modified carries the `decision` of the lead (the answer to the targeted question). The list may be empty (`[]`: the lot touches no data).

**Mixed sheet** (a lot with `screen:` and a back-end part): `sujet` **and** `ecran` side by side, with the same `id` (the folder name) and the same `lot`. A rule is attached to a state (`etat`, a screen rule) or to cases (`cas`), at least one of the two. The `A` ids are shared: the actions of the screen and the `contrats` are numbered `A1…An` with no gap over the whole, and an action that calls an API already listed in `contrats` points to it with `contrat: Ax` instead of repeating its `appel`. An action that has its own `appel` equal to the `appel` of a contract is reported (it must point to the contract). A sheet without `ecran` refuses `actions`, `etats` and `champs` (they only make sense with a screen part), and a rule with `etat` there gets that single report. A sheet that only has `ecran` stays valid as it is (no migration); `sujet` is required as soon as the lot is back-end or mixed.

`cadence spec check` prints the same summary line for each kind (`N cas, N règles (N hypothèses), N contrats, N données` for a back-end sheet) and keeps its exit codes: 0 valid, 1 violations, 2 usage.

`cadence spec reseal <lot> <test> --reason texte` is the lead's way to correct one sealed acceptance test of the lot in progress that contradicts its sheet (unchanged, or amended by commits of the lot, L217; of a delivered lot, also by commits of another delivered lot, L229) (of a delivered lot: add `--porteur <lot in progress>`); refused while a wave of the repository is running, or a wave that is not `done` keeps open (question waiting, suspended, queued) any lot of this repository still `doing` in its plan, the resealed lot or another (L238: one error, also when a live wave holds the lock, names each wave (live ones to wait for), its launch folder and, for each stopped wave, the single `cd <folder> && cadence orchestrate --resume --wave <wave> --drop <project>:<lot> --drop …` that closes all its open lots of the repository, the queued ones that are not `doing` in the plan included (L239); a lot `done` or absent in the plan never refuses), see [The accept step](orchestrate.md#the-accept-step-red-acceptance-tests-and-their-lock).

`cadence spec green <lot>` (L366, GitHub issue #18) is the lead's way to put back to green a lot driven and closed by hand (`raf done`) whose `acceptation-<lot>.json` stayed at `vert: false`: closed like that, its tests keep the lock total and every later wave of the repository is handed back with `verrou des tests d'acceptation … premier commit fautif` on lots that never touched them, and `spec reseal` does not cover it (it takes a lot `doing`, or a delivered lot at `vert: true` with `--porteur`). The program runs the lot's acceptance command (`orchestrate.accept`, same rules as the cycle) and, green, sets `vert: true`, reseals the listed tests refined since the red commit (one `resceaux` entry each) and commits the file alone, citing the lot (`chore(<lot>): acceptation verte, vert: true posé par cadence spec green`, or the project's `plan.commit` template when it has one; the subject stays short and fixed, the tests resealed are listed in the commit body, one `- <path>` line each, so a `header-max-length` hook accepts it); red, the tail of the output goes to stderr, exit 1, nothing changed; already green, nothing to do. Refused for a `todo` lot, from a session (`CADENCE_ORCHESTRATED`), during a wave of the repository and while an unfinished wave keeps a lot of the repository open (the same refusals as `spec reseal`, worded for `spec green`); a listed test changed but not committed is refused before anything runs. `raf done` refuses such a lot without `--force`, and `cadence orchestrate --dry-run` prints `acceptation rouge d'un lot clos` once per repository, see [A closed lot left at vert: false](orchestrate.md#the-accept-step-red-acceptance-tests-and-their-lock).

`cadence spec qa <fiche.yaml>` derives from a valid sheet the section of `docs/qa/expectations.md` for its screen and prints it on the standard output
(it never writes the file: you paste the section, and the lead commits it like the rest of the plan files). A sheet with violations prints them on the
error output, nothing on the standard one, and exits 1. The derivation is built so that the planned empty and error states are never reported as defects:

- `## <route>` is the screen's route;
- `shows:` — one line per mandatory field (its `libelle`), **except** the fields that belong to a state (listed in `champs` of a rule of state `vide` or `erreur`, like the empty-state message);
  the line of a field listed in the `masque` of a `sourcee` rule of state `vide` ends with `— unless <the rule's statement>`; the other fields (a static title) never get one;
- `never:` — the messages of the rules of state `erreur`, on one line; the message of a rule of state `vide` is a planned display and never goes there;
- `api:` — the load actions only (`declencheur: null`) in `GET` (the QA pass never sends a POST); the line ends with `may be empty when <the rule's statement>` when a `sourcee` rule of state `vide` carries the action.
  Actions triggered by a field stay with the acceptance tests.

`spec qa` only derives the **screen** part: a back-end sheet, which has no `ecran`, is refused (exit 2, « la fiche n'a pas de partie écran »); on a mixed sheet it reads the actions' calls through their `contrat`.



## Spec step (design, first steps delivered)

For a visible lot that adds a page (`screen: page`; a component or a journey follows the ordinary path since L209), `orchestrate` gets a step
before the code: a static HTML mockup in the project's own style (1440 and 390 px; empty, loading and
error states) and a machine-readable screen sheet (fields, numbered rules `R1…` each marked *sourced*
or *hypothesis*, actions → API calls). The `ux-reviewer` agent reads the mockup before any code; the
acceptance tests are written from the sheet, red, by a session other than the implementer's; the
implementation gets the sheet, the code review checks rule → test → green, the hypotheses go into the
lot's news entry, and a human is asked only about a choice that is costly to undo. The design is in
`docs/superpowers/specs/2026-10-10-etape-spec-design.md` (with an example sheet and the plan of the
lots that deliver it). Delivered so far: the sheet templates `templates/fiche.yaml` (screen) and `templates/fiche-back.yaml` (a lot without a screen: `sujet`, `cas`, `regles`, `contrats`, `donnees`), `cadence spec check`
(the sheet's invariants) and `cadence spec qa` (the screen's `docs/qa/expectations.md` section, derived
from the sheet), see [spec](#spec) below, and the `spec` step of `orchestrate` itself (the `spec-writer` agent, the
render at 1440 and 390 px, the commit of the spec), see [The spec step](orchestrate.md#the-spec-step-of-a-lot-with-screen) in `orchestrate`; the `accept` step (red acceptance tests and the lock that protects them), see [The accept step](orchestrate.md#the-accept-step-red-acceptance-tests-and-their-lock); the UX review of
the mockup (the `ux-reviewer` agent in mockup mode), see [The mockup review](orchestrate.md#the-mockup-review-before-any-code); and the downstream briefs (the sheet given to `implement`, rule → test → green in the code review, a light UX conformity pass, the `## Hypothèses` section of the news entry), see [The downstream briefs](orchestrate.md#the-downstream-briefs-sheet-rule--test--green-conformity-hypothèses).
