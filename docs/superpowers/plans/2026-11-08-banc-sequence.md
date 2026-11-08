# Cadence 2 — plan n°3 : banc « séquence »

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task gives interfaces, behaviour and test cases. Unlike plan n°1, it does not give the full code: the interfaces of the bench are already established, and plan n°1 showed that capable implementers plus hard reviews beat dictated code.

**Goal:** Measure what cadence exists for: regressions across successive lots, real reading of references, maintainability drift. A sequence of real demands of one project is replayed, and each arm keeps its code from one demand to the next.

**Spec:** `docs/v2/2026-11-08-banc-sequence-design.md`. Context: `docs/v2/2026-11-07-cadence-2-design.md`.

## Global Constraints

- New module `v2/src/sequence/`.
- Budget, controller ruling R23, rebalanced within the 3 000 total: bench 800, sequence 350, plan 400, accueil 200, run 500, porte 250, deliver 450.
- Reuse the bench modules. Do not copy them: preparer, lancerBras, fuitesDuBras, juger, verdict helpers, lock, `pretAPasser`, en-cours.
- Everything from plan n°1 still holds:
  - prod guards, one arm at a time, blind judges, fail-closed verdict;
  - anti-relapse rules C1-C5. Every new option goes into options.json and every arm brief passes the rules;
  - TDD, explicit commits with the trailer, no full v1 suite.
- Data lives in `~/bench-cadence/sequences/<id>/` (public) and `~/bench-cadence/secrets/sequences/<id>/` (hidden, mode 0700). It is prepared outside this plan.

## Review Focus

1. **Hidden tests leaking into an arm's clone.** Hidden tests are copied into the clone to be run. They must be removed afterwards, and the clone must be byte-identical to before (`git status` and untracked files unchanged). The next step's arm must never see them.
2. **A regression counted wrongly.** A test that failed before is not a regression. Only a test that passed at an earlier step and fails now counts.
3. **The reading check fooled.** A `Read` on a piece AFTER the first code write does not count. Opening only page 1 of a big document counts as opened, but the report says « partiel ».
4. **One arm's state leaking into the other.** Each arm has its own clone, kept for the whole sequence.
5. **A step that fails (`echec`).** The sequence goes on with the arm's code as it is, and the verdict goes red.

---

### Task S1 — Defining a sequence

- `v2/src/sequence/sequence.ts`:
  - `interface Etape { k: number; lot: string; demande: string /* abs path */; pieces: string[]; taille: 'retouche'|'fonction' }`
  - `interface Sequence { id; dir; secrets; projet; source; base; install; tests; etapes: Etape[]; caches: Record<number, { fichiers: string[]; commande: string }>; regression: { a_partir_de: number; fichiers: string[]; commande: string } }`
  - `chargerSequence(racine, id): Sequence`. It reads `sequences/<id>/sequence.yaml` and `secrets/sequences/<id>/sequence-secrets.yaml`, and validates them with field-named errors: missing base, unknown taille, a piece that does not exist, steps not numbered 1..n.
- Tests: valid fixture; each invalid case.

### Task S2 — Measures after one step (pure where possible)

- `v2/src/sequence/mesures.ts`:
  - `jouerTests(clone, fichiers: {src, dest}[], commande, delaiMs): { passes: number; total: number; echoues: string[] }`
    - Copies each hidden test into the clone under a unique name (`*.banc-cache.spec.ts` next to its destination).
    - Runs the command restricted to those files, with JSON output: vitest `--reporter=json --outputFile`.
    - Deletes the copies in a `finally`.
    - Asserts that `git status --porcelain` and the untracked list are identical to before; on mismatch it throws `CloneModifie`.
  - `regressions(avant: Record<string, boolean>, apres: Record<string, boolean>): string[]` — tests that passed in `avant` and fail in `apres` (pure).
  - `lectureReferences(lignesTranscript: string[], pieces: string[]): { ouvertes: string[]; manquantes: string[]; apres_ecriture: string[] }`
    - Finds `Read` tool_use calls whose `file_path` resolves to a piece.
    - « before the first write » means before the first `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool_use on a file inside the clone. Pure.
  - `maintenabilite(clone, dossiers: string[]): { duplication_pct: number; plus_gros: {fichier, lignes}[]; fichiers_400: number }`
    - Duplication through `npx --yes jscpd@4 --reporters json --silent` on the given folders. If jscpd is unavailable, the field is `null` and stays visible, never 0.
    - Sizes are counted from the files.
- Tests:
  - the copy/cleanup invariant, including when the command throws;
  - regressions with a test that was already red before (not counted) and with a new test;
  - reading before and after the first write, and reading a piece outside the list;
  - jscpd absent → `null`.

### Task S3 — Running a sequence

- `v2/src/sequence/passage.ts`: `passageSequence(o): ResultatSequence`
  - Takes the lock, runs `pretAPasser` and maintains en-cours (`banc: <seq>`, `etape: k/n`).
  - For each arm, one clone `runs/<run>/<seq>/<bras>-anonyme` → named `c1`/`c2` as in R9, prepared once at the base.
  - For each step k, in arm order alternating with k:
    - build a Banc-like object for lancerBras (`dir` = step folder, so `demande.md` and `pieces` come from the step);
    - run the arm in a fresh session;
    - record `travailNonLivre` (I-2), leaks (both classes), the reading check from the arm's transcripts for this step, hidden tests of steps ≤ k (cumulative, by test id), regression tests if k ≥ `a_partir_de`, regressions versus the previous step, maintainability;
    - write `etape-<k>.json` per arm.
  - An arm echec at step k is recorded, and the sequence continues with its code as is.
  - At the end, `juger` is called on the final state. Its diff is base..HEAD of the whole sequence. Its brief gets the list of all demands (a new `{{DEMANDES}}` field in the judges' briefs, filled in sequence mode; anti-relapse C1 must still pass).
  - Clones are archived as in I-3.
- Tests with the fake executor:
  - 3 steps × 2 arms, order alternates by step;
  - a fake arm that breaks an earlier hidden test at step 2 → 1 regression counted for that arm only;
  - a fake arm that writes code before reading the piece → `apres_ecriture` listed;
  - an echec at step 2 → step 3 still played.

### Task S4 — Sequence verdict, report, history, publication

- `v2/src/sequence/verdict.ts`: `verdictSequence(r, ref, cand)`. It reuses the Critere shape and the bar of spec §4. Blocking criteria:
  - régressions ≤ ref;
  - cumulative hidden tests ≥ ref;
  - pieces read before the first write = 100 % for the candidate, and shown for the reference;
  - maintainability slope ≤ ref: duplication and big files at the last step minus step 0;
  - time ≤ 1.5 × ref;
  - no leak, no arm echec, final judge done, fail-closed on empty or missing data.
- Report: one table per step, side by side; then the criteria; then « Lectures à vérifier » and « Questions posées ».
- History line `type: 'sequence'`.
- `statut` (v1 verdict.ts), publication: the latest relevant court run AND the latest sequence run on the fingerprint must both be green, with the same candidate and model. Same rules as C-1.
- Tests for each criterion green/red; empty sequence → red; publication refused with only a court green; HUD `sorte` shows « séquence ».

### Task S5 — Candidate arm: mandatory reading + sequence brief

- `v2/hooks/lecture-obligatoire.mjs`, a PreToolUse hook for `Edit|Write|MultiEdit|NotebookEdit`.
  - It reads the hook JSON from stdin (`tool_input.file_path`, `transcript_path`) and the list of pieces in `<clone>.pieces.json`, which the bench writes before each step.
  - It denies with « Lis d'abord : <pièces non ouvertes> » when a piece has not yet been Read in the transcript.
  - Images count once Read.
  - Writes outside the clone are not concerned.
- `DefBras` gains an optional `settings` path. `lancerBras` passes `--settings <file>` (the settings file of the candidate arm declares the hook).
- `v2/briefs/bras-sequence-v2.md`, derived from bras-flux-v2.md:
  - the size is given by the bench as « Taille fixée par le gardien : … » (from `Etape.taille`), not by the arm;
  - read `.cadence/carte.md` first if it exists, then update it in a few lines at the end of the step (screens, workflows, decisions);
  - run the project's FULL suite before committing, and keep the tests of every past demand green;
  - one review round, for a fonction only.
- Anti-relapse rules apply.
- Tests:
  - hook: deny/allow from fixture transcripts, and an image counted;
  - lancerBras passes `--settings`;
  - the anti-relapse rules on the new brief.

### Task S6 — CLI, options, docs, HUD

- `cadence2 bench sequence <id> [--candidat c] [--reference r] [--repetitions N]` and the options.json keys.
- `docs/v2/banc.md`: a « Banc séquence » section.
- HUD en-cours: the line shows « étape k/n » for a sequence.
- Tests on the CLI parsing and usage.

### Task S7 — First real run (controller)

- Show Sylvain the reconstructed demands (`RECONSTRUITES.md`) before running.
- `cadence2 bench sequence aether-b68 --candidat sequence-v2 --reference A --repetitions 2`, which needs ~5 h with HUD visibility.
- Verdict to Sylvain, step by step.
