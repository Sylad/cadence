import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { AGENTS_DIR, installSkills, SKILLS_DIR } from '../src/skills.js';
import { gitRepo, tempDir } from './helpers.js';

const flat = (text: string): string => text.replace(/\s+/g, ' ');
/** Le contrat de l'agent QA, en-tête et corps séparés : une clause du corps ne peut pas être tenue par la seule description. */
const qaAgent = (): { description: string; body: string; section: (title: string) => string } => {
  const agent = readFileSync(join(AGENTS_DIR, 'qa-reviewer.md'), 'utf8');
  const end = agent.indexOf('\n---\n', 4);
  const body = agent.slice(end + 5);
  return {
    description: flat(agent.slice(0, end)),
    body: flat(body),
    section: (title) => {
      const start = body.indexOf(`## ${title}\n`);
      if (start < 0) throw new Error(`section « ${title} » absente de l'agent qa-reviewer`);
      const next = body.indexOf('\n## ', start + 1);
      return flat(body.slice(start, next < 0 ? undefined : next));
    },
  };
};
/** Ce qui déclenche la revue QA : les mêmes mots dans l'agent, les skills lead et deliver, et le README. */
const QA_TRIGGER = 'changes what a page shows or what it is served (screen, API, data source, configuration of either) — in practice every delivery except docs-, plan- or tests-only ones';
/** Le format du fichier d'attentes : le contrat de l'agent et le README disent la même chose, mot pour mot. */
const QA_FORMAT = [
  'each must answer 2xx with a non-empty body',
  'An optional `## *` section holds what every page must show, never show and call.',
  'A line may end with a condition in plain words, which',
  '`may be empty when …`, `1440 only`, `390 only` (a line without a width holds at both).',
  'ontent hidden on the phone by design is not a defect unless a `shows:` line requires it at 390; content pushed outside the visible area (it needs a sideways scroll) is reported as suspect and handed to `ux-reviewer` in one line',
  'is a failure, unless its line says `may be empty when …`',
];
/** La coupe de la cascade de mineurs : mêmes mots dans le skill lead, les briefs de revue et l'agent. */
const MINOR_RULE_BRIEF = 'A proposed sub-task describes an observable bug (a wrong output, a crash, a measured regression); any other minor finding stays a note of this lot, not a sub-task.';
const MINOR_RULE = 'A minor finding becomes a lot of its own only if it describes an observable bug (a wrong output, a crash, a measured regression); otherwise it stays a note of the originating lot, so that a review never feeds the next one.';

const skillText = (name: string): string => flat(readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'));
/** La section « QA review » du README, jusqu'au titre suivant. */
const readmeQa = (): string => {
  const readme = readFileSync(join(AGENTS_DIR, '..', 'README.md'), 'utf8');
  return readme.slice(readme.indexOf('### QA review'), readme.indexOf('## session'));
};

describe('skills install', () => {
  it('copie les skills préfixés, idempotent, refuse un écrasement sans --force', () => {
    const dest = join(tempDir(), '.claude/skills');
    expect(installSkills(SKILLS_DIR, dest, false)).toEqual([
      { name: 'cadence-deliver', status: 'installed' },
      { name: 'cadence-lead', status: 'installed' },
      { name: 'cadence-session-close', status: 'installed' },
      { name: 'cadence-session-start', status: 'installed' },
    ]);
    const file = join(dest, 'cadence-session-start/SKILL.md');
    expect(readFileSync(file, 'utf8')).toMatch(/^---\nname: cadence-session-start\n/);
    expect(installSkills(SKILLS_DIR, dest, false).every((r) => r.status === 'unchanged')).toBe(true);

    writeFileSync(file, 'modifié à la main');
    expect(() => installSkills(SKILLS_DIR, dest, false)).toThrow(/cadence-session-start.*--force/);
    expect(readFileSync(file, 'utf8')).toBe('modifié à la main');
    expect(installSkills(SKILLS_DIR, dest, true).find((r) => r.name === 'cadence-session-start')?.status).toBe('updated');

    const other = join(tempDir(), 'skills');
    mkdirSync(join(other, 'cadence-deliver'), { recursive: true });
    expect(() => installSkills(SKILLS_DIR, other, false)).toThrow(/cadence-deliver/);
  });

  it('CLI : installe dans .claude/skills du dépôt par défaut', async () => {
    const dir = gitRepo();
    const out: string[] = [];
    const code = await run(['skills', 'install'], { cwd: dir, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('cadence-deliver : installé');
    expect(readFileSync(join(dir, '.claude/skills/cadence-deliver/SKILL.md'), 'utf8')).toContain('name: cadence-deliver');
    expect(out.join('\n')).toContain('cadence-ux-reviewer (agent) : installé');
    expect(readFileSync(join(dir, '.claude/agents/cadence-ux-reviewer.md'), 'utf8')).toMatch(/^---\nname: cadence-ux-reviewer\n/);

    writeFileSync(join(dir, '.claude/agents/cadence-ux-reviewer.md'), 'à la main');
    const again = await run(['skills', 'install'], { cwd: dir, env: {}, out: () => {}, err: () => {}, now: () => new Date() });
    expect(again).toBe(2);
    expect(readFileSync(join(dir, '.claude/agents/cadence-ux-reviewer.md'), 'utf8')).toBe('à la main');
  });

  it('CLI : installe aussi l’agent code-reviewer, en lecture seule et sans outil d’écriture', async () => {
    const dir = gitRepo();
    const out: string[] = [];
    const code = await run(['skills', 'install'], { cwd: dir, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('cadence-code-reviewer (agent) : installé');
    const agent = readFileSync(join(dir, '.claude/agents/cadence-code-reviewer.md'), 'utf8');
    expect(agent).toMatch(/^---\nname: cadence-code-reviewer\ndescription: .+\ntools: Read, Grep, Glob, Bash\n---\n/);
    expect(agent).toContain('raf review <lot> "…"');
  });

  it('agent code-reviewer : le contrat amendé après sa première revue réelle', () => {
    const agent = readFileSync(join(AGENTS_DIR, 'code-reviewer.md'), 'utf8');
    // Les commits viennent de l'outil ; le grep n'est qu'un repli, avec la garde droite qui écarte NC2.4 de NC2.
    expect(agent).toContain('`raf commits <id>`');
    expect(agent).toContain("--grep='(^|[^[:alnum:]_/.-])<id>($|[^[:alnum:]_.-]|\\.($|[^[:alnum:]_]))'");
    expect(agent).toMatch(/Only\s+when `raf` is not available, fall back to/);
    expect(agent).not.toContain('<id>($|[^[:alnum:]_-])');
    const text = agent.replace(/\s+/g, ' ');
    for (const clause of [
      'If the repository has no CLAUDE.md, say so in the report',
      "a parent folder's CLAUDE.md does not count unless it names this project",
      'in the README, then in the manifest (`package.json` scripts, Makefile, `pyproject.toml`…)',
      'A linter or coverage tool the project does not have goes under "not verified": it is not a finding',
      'never run a build whose output directory is used live',
      'a `bin` entry or a symlink on the PATH points to',
      'in a temporary directory outside the repository, removed afterwards: the working tree is left as you found it',
      'When the lot has only a title, also read the bodies of its commits and any spec the lot cites',
      "on a read-only plan (`cadence.yaml` maps the fields of a file kept by another tool), plain lines for the project's own tool",
      'Untested code that is practically unreachable, and a rule that holds as written while an edge defeats its purpose, are *minor* — unless they can lose or corrupt data',
      'It is the last line of the review; extra sections a caller asks for come after it',
      'When the brief says the program already ran the tests and the build, take those results as given: do not rerun them',
      'a green run you did not launch, as proof — except the results the brief says the program ran itself',
    ]) expect(text).toContain(clause);
  });

  it('CLI : installe aussi l’agent qa-reviewer, en lecture seule (liste d’outils sans Edit ni Write, L140)', async () => {
    const dir = gitRepo();
    const out: string[] = [];
    const code = await run(['skills', 'install'], { cwd: dir, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('cadence-qa-reviewer (agent) : installé');
    const agent = readFileSync(join(dir, '.claude/agents/cadence-qa-reviewer.md'), 'utf8');
    expect(agent).toMatch(/^---\nname: cadence-qa-reviewer\ndescription: .+\ntools: Read, Grep, Glob, Bash, mcp__playwright, mcp__plugin_playwright_playwright\n---\n/);
    expect(agent).not.toMatch(/^tools:.*\b(Edit|Write)\b/m);
  });

  it('agent qa-reviewer : le contrat — lecture seule, attentes du projet, constats mesurés', () => {
    const agent = readFileSync(join(AGENTS_DIR, 'qa-reviewer.md'), 'utf8');
    const text = agent.replace(/\s+/g, ' ');
    for (const clause of [
      // Lecture seule : ni le code, ni le plan, ni les attentes ; GET seulement, arrêt devant un PIN.
      'You report; you never edit code, the plan or the expectations',
      'never log in, never submit a form that writes',
      'GET only',
      'If a PIN or a login wall is met, say so and stop there for those pages',
      // Entrées.
      'The absolute path of the repository and the base URL of the app',
      'Optionally a lot id: then walk only the pages that lot touched',
      // Le fichier d'attentes, et son absence.
      '`docs/qa/expectations.md`, or the file named by `qa.expectations` in `cadence.yaml`',
      'No expectations file: do not guess silently',
      'Return a DRAFT expectations file as text',
      'without expectations an empty state cannot be told from a normal one',
      // Ce qui se mesure, aux deux largeurs.
      'in a real browser',
      'at **1440 px** and **390 px** wide',
      'answered 2xx with a non-empty body: note the status and the response size',
      '**Open each page in a real browser** (Playwright, or the browser tool available), at **1440 px** and **390 px** wide.',
      'A 200 with an empty or null body (`[]`, `{}`, `null`, 0 bytes) is a failure, unless its line says `may be empty when …`',
      'no console error',
      'no broken image among the content images',
      'never an impression',
      // Périmètre (le classement est épinglé dans le test suivant).
      'usability and accessibility belong to `ux-reviewer`, code quality to `code-reviewer`',
      // Sortie.
      '**Pages checked N/N**, with the base URL and the date and time of the run',
      'one `raf add "…"` line per finding worth doing',
      "plain lines for the project's own tool",
      '**Verdict**, one line',
      '**Not verified**',
      'in a temporary directory outside the repository',
    ]) expect(text).toContain(clause);
    // Une page vide alors que tout est vert : la raison d'être de l'agent reste écrite dans son contrat.
    expect(text).toContain('a players page with no players is a defect, whatever the cause');
  });

  it('agent qa-reviewer : chaque garantie est épinglée — une clause retirée fait échouer le test', () => {
    const qa = qaAgent();
    const method = qa.section('Method');
    // Lecture seule : aucun verbe d'écriture, aucun contrôle qui change une donnée.
    expect(method).toContain('**GET only, and nothing that writes**: never log in, never submit a form that writes, never click a control that changes data, never send a POST, PUT, PATCH or DELETE yourself.');
    // Devant un PIN ou une connexion : ni constat, ni page vérifiée.
    expect(method).toContain('If a PIN or a login wall is met, say so and stop there for those pages: they go under "not verified", they are neither a finding nor a page checked.');
    // Le brouillon d'attentes est rendu en texte, jamais écrit dans le dépôt.
    expect(method).toContain('a DRAFT expectations file as text, for the human to correct: you do not write it into the repository.');
    // Trois sortes de constat. Les vérifications universelles n'ont pas besoin du fichier d'attentes.
    expect(method).toContain('- *defect* — a line of the expectations is broken, or a universal check fails with a visible effect on the page: an error message shown, a failed API call whose content is missing on screen, a broken or missing content image. Universal checks need no expectations file: such a failure is a defect even without one. An API call that answers 2xx with an empty body is a defect only when an expectation says data is due there; without one it is suspect at most (it may be a normal absence);');
    expect(method).toContain('- *suspect* — something that looks like missing or wrong data and that no expectation settles: an empty list under a heading, a "nothing found" message, a status or label contradicted by the page\'s own data ("eliminated" beside a won match), a stale season label. Say why, and propose the line of expectations that would settle it;');
    expect(method).toContain('- *noise* — a console error or a failed request with no visible effect: reported, ranked minor;');
    expect(method).toContain('- *out of scope* — usability and accessibility belong to `ux-reviewer`, code quality to `code-reviewer`: one line at most, never a finding.');
    // Les trois rangs ; un contenu faux compte comme un contenu manquant.
    expect(method).toContain("**Rank** each finding: *blocking* (a page's main content is missing, its main information is false, or an error is shown to the user), *major* (secondary content missing or wrong, a section silently dropped after a failed or empty API call, a broken content image), *minor* (noise).");
    // Sans fichier d'attentes : les vérifications universelles tiennent, le reste est suspect au plus.
    expect(method).toContain('report what you saw: the universal checks hold without a file, and anything that would need an expectation to judge is *suspect* at most.');
    expect(method).toContain('Say plainly that without expectations an empty state cannot be told from a normal one.');
    expect(method).not.toContain('never *defect*');
    // La méthode que le premier passage réel a dû inventer, écrite dans l'étape 4.
    const step4 = method.slice(method.indexOf(' 4. **Open each page'), method.indexOf(' 5. **GET only'));
    for (const clause of [
      // « Stabilisée » : jamais l'inactivité du réseau, qu'un flux ou un rafraîchissement périodique n'atteint pas.
      'Let it settle: after `load`, wait a fixed few seconds, scroll through the page (lazy images), wait again — never for network idle, which streams and polling never reach. Then measure:',
      // La taille d'une réponse, et l'outil qui sait l'écouter.
      'note the status and the response size (decoded body bytes; streams — SSE, websockets — are exempt from the size rule).',
      'This takes a tool that listens to responses (e.g. a Playwright `page.on(\'response\')` listener): if yours cannot give status and size, say so under "not verified" instead of pretending;',
      // Images de contenu : une pastille de repli n'a pas de balise img.
      'count the items that should carry an image and have no loaded `<img>` — a fallback badge replacing a failed image has no `<img>` at all;',
      // États derrière un contrôle : on peut changer la vue, jamais écrire.
      '- states behind controls: tabs, filters and other controls that only change the view may be used and are part of the page (a tab that triggers its own API call is checked like a page); a control that writes is never used;',
      // Rythme : un 429 se rejoue seul avant de conclure.
      '- pacing: pause between pages; when a 429 (or any rate-limit answer) appears, re-run that page ALONE after a quiet minute before concluding — if it reproduces, an ordinary visitor gets it; if not, it was your own pace and it is not a finding;',
      // Le code source situe une cause, il ne prouve rien.
      '- the frontend source may be read to LOCATE a cause after a measurement, never as evidence.',
    ]) expect(step4).toContain(clause);
    expect(method).not.toContain('wait until its requests have settled');
    const output = qa.section('Output');
    // N/N : vérifiée aux deux largeurs ; une vérification partielle est comptée et nommée comme telle.
    expect(output).toContain('A page counts as checked when both widths were measured; a page checked partially (one width, tabs not opened) is counted and named as partial.');
    expect(output).toContain('a browser tool that was missing or could not give status and size — stated plainly.');
    expect(output).toContain('each with: the route, its kind and rank, what was expected — quote the line of the expectations, or name the universal check, or, for a suspect, give the expectation line you propose —, what was measured, and the evidence — status code, response size, the text on screen, the capture.');
    expect(output).toContain('"no expectations file: 13 pages walked, 1 defect, 8 suspects, draft returned"');
    expect(output).toContain('a page you could not open is counted and named, never dropped');
    expect(output).toContain('No finding without a measurement.');
    expect(output).toContain('It is the last line of the report.');
    // Les quatre interdits, et eux seuls.
    const bans = qa.section('Do not');
    expect(bans).toBe([
      '## Do not',
      '- Report an impression: a finding you have not measured in the browser is not a finding.',
      '- Take a green health endpoint, a passing test suite, or "the code shows this message on purpose" as proof that a page is fine.',
      '- Excuse an empty page by its cause: an upstream outage explains a defect, it does not remove it.',
      '- Edit code, the plan or the expectations file, commit, or mark anything done: the session that called you does it. ',
    ].join(' '));
    expect(qa.description).toContain('never an impression');
    expect(qa.description).toContain("Given a repository path and a base URL, it checks each page against the project's expectations file (`docs/qa/expectations.md` — per route, what the user must find, what must never appear, the API calls the page depends on) at a desktop and a phone width;");
    // Ce que le balayage clause par clause laissait encore passer : entrées, mesures, décompte, fichiers temporaires.
    expect(qa.body).toContain('You check a running web app the way its user meets it: page by page, in a real browser.');
    expect(qa.body).toContain('A page can be empty while everything else is green: no code changed, a data source went down upstream, the unit tests replace the network, the health endpoint answers ok, and the message on screen is exactly the one the code was written to show. Neither a test nor a code review calls that a defect. You do:');
    expect(qa.section('Inputs')).toContain('The absolute path of the repository and the base URL of the app — deployed, or a local server the caller started.');
    expect(qa.section('Inputs')).toContain('If the path or the URL is missing, or the URL does not answer, say so and stop.');
    expect(method).toContain("**Read how to reach the app**: the project's CLAUDE.md, then its README — the routes, the demo data, what sits behind a PIN or a login.");
    expect(method).toContain('- the expected content is present and non-empty — name the selector or the text found and its count (`.player-card` ×14), not "the list looks fine";');
    expect(method).toContain('- no `never:` text on screen, and no other error or missing-data message;');
    expect(method).toContain('- every API call of the page — those listed, and those you saw it make to its own backend — answered 2xx with a non-empty body:');
    expect(method).toContain('- no console error: quote the first line of each;');
    expect(qa.section('Output')).toContain('The second N is every page of the expectations (or every route discovered): a page you could not open');
    expect(qa.section('Output')).toContain('- **Proposed follow-ups**: one `raf add "…"` line per finding worth doing;');
    expect(qa.section('Output')).toContain('Without an expectations file, the draft comes here.');
    expect(qa.section('Output')).toContain('- **Verdict**, one line, alone — e.g. "6/6 pages as expected", "not as expected: 1 blocking (/players shows no player)",');
    // Le profil QA survit aux passes : il est exclu du nettoyage des fichiers temporaires.
    expect(qa.section('Output')).toContain('Other temporary files go in a temporary directory outside the repository, or in the one the caller names; remove them, or list their paths in the report — except the QA browser profile, which is kept for the next pass. The working tree is left as you found it.');
    expect(qa.description).toContain('without an expectations file it still runs its universal checks, reports what it saw and returns a draft one.');
    expect(qa.description).toContain('reports empty states, wrong data, error messages, failed or empty API calls, console errors and broken images.');
    // Déclencheur : toute livraison qui change ce qu'une page montre ou reçoit — pas seulement un lot « visible ».
    expect(qa.description).toContain(`Use after any delivery that ${QA_TRIGGER} — or to re-check a deployed app.`);
    expect(qa.description + qa.body).not.toContain('`visible`');
    expect(qa.section('Inputs')).toContain('then walk only the pages that lot touched, as « Scope of a lot » below says.');
    expect(qa.description).toContain('Read-only — does not modify code, log in or submit anything.');
  });

  it('agent qa-reviewer : amendements du second passage réel (L10) — chaque clause est épinglée', () => {
    const method = qaAgent().section('Method');
    const step = (from: string, to: string): string => method.slice(method.indexOf(from), method.indexOf(to));
    const step1 = step(' 1. **Read how', ' 2. **Read the expectations');
    const step4 = step(' 4. **Open each page', ' 5. **GET only');
    const step5 = step(' 5. **GET only', ' 6. **Classify');
    const step6 = step(' 6. **Classify', ' 7. **Rank');
    const step7 = method.slice(method.indexOf(' 7. **Rank'));
    // État du navigateur : le bundle chargé contre celui que référence index.html relu sans cache, puis le cache vidé.
    expect(step4).toContain("browser state, once before the first page, in a profile already used (a persistent context, not a fresh one — a `userDataDir` reserved for QA and kept between passes, never the user's own browser profile): compare the bundle the page loaded (its script URL) with the one `index.html` references, re-read without cache — a returning visitor still holds the old one, so a difference is stated in the report — then clear the cache and measure;");
    // « GET only » n'est pas « sans effet » : un CDN met en cache une sonde sur un actif absent.
    expect(step5).toContain('GET only is not "without effect": a probe on an asset name that does not exist is cached by a CDN and then served to real visitors. Request only URLs the app itself uses, or add a cache-busting query parameter.');
    // La minute de calme se passe hors de l'app.
    expect(step4).toContain('the quiet minute is spent on `about:blank`, never on the app, whose polling would keep calling its backend;');
    // Comparaison des textes sans casse.
    expect(step4).toContain('- texts are compared without case (`never:` texts, labels, statuses): "Eliminated" and "ELIMINATED" are the same text;');
    // Les lots ouverts du plan : un constat déjà planifié tient en une ligne.
    expect(step1).toContain('Read the open lots of the plan (status `todo` or `doing`) with `raf list --status todo` and `raf list --status doing`, or the project\'s own tool when the plan is read-only');
    expect(step6).toContain('a finding already planned by an open lot is returned in one line — the lot id and its title — not as a new finding and not as a follow-up;');
    // README : « déjà planifié » est une quatrième sorte de constat, avant le hors-périmètre.
    const readme = readFileSync(join(AGENTS_DIR, '../README.md'), 'utf8').replace(/\s+/g, ' ');
    expect(readme).toContain('visible effect, ranked minor) or already planned (an open lot covers it: returned in one line, the lot id and its title)');
    expect(step6.indexOf('*already planned*')).toBeGreaterThan(step6.indexOf('*noise*'));
    expect(step6.indexOf('*already planned*')).toBeLessThan(step6.indexOf('*out of scope*'));
    // États simulés par interception : permis, jamais un constat à eux seuls.
    expect(step4).toContain('- simulated states: a route you intercept to fail or answer empty may be used to see how the page copes; what it shows is never a finding by itself — only what the real app serves is;');
    // Liens sortants : lus, jamais requêtés.
    expect(step4).toContain('- outbound links (another origin): each has a real `href` (not empty, not `#`) — `rel=noopener` is not required, `target=_blank` implies it since Chrome 88, Firefox 79 and Safari 12.1 — read from the attributes, never requested;');
    expect(step4).not.toContain('carrying `noopener`');
    // La section Output dit où va la ligne « already planned » : ni dans Findings, ni dans les follow-ups.
    expect(qaAgent().section('Output')).toContain('- **Already planned**: one line per finding already planned by an open lot — the lot id and its title —, kept out of Findings and of Proposed follow-ups.');
    // Largeur de mise en page mesurée.
    expect(step4).toContain('`document.documentElement.scrollWidth` against `clientWidth` at each width');
    // Rang d'une ligne d'attente cassée sans perte visible.
    expect(step7).toContain('A broken line of the expectations with no visible loss on the page (the content is on screen by another path) is *minor*');
  });

  it('agent qa-reviewer : passage borné, résultats écrits page par page, jamais d’attente silencieuse (L101)', () => {
    const qa = qaAgent();
    const bounded = qa.section('Bounded pass');
    // Un budget de temps, donné par l'appelant ou par défaut, compté par l'agent.
    expect(bounded).toContain('The pass has a time budget: the one the caller names, otherwise 15 minutes. You keep the count');
    // Jamais d'attente silencieuse sur son propre travail de fond.
    expect(bounded).toContain('Never wait in silence on your own background work');
    expect(bounded).toContain('every wait has a timeout and is announced');
    // Page par page, au fil de l'eau, pas un JSON unique en fin de passage.
    expect(bounded).toContain('After each width measured, append its measurements to a results file in the temporary directory — one line per page and width, the page and the width named — before measuring the next. Never one single file written at the end of the pass');
    // Le budget épuisé ou l'arrêt demandé : rapport depuis le fichier, partiel nommé.
    expect(bounded).toContain('When the budget is spent, or the caller asks you to stop, stop walking and write the report from the results file');
    expect(bounded).toContain('the pages not reached are named, never dropped');
    // La section Method renvoie vers le passage borné.
    expect(qa.section('Method')).toContain('Walk within the bounded pass below.');
    // Le passage partiel se dit dans le rapport.
    expect(qa.section('Output')).toContain('If the pass stopped before the end (budget spent, stop requested), say so in the first line');
  });

  it('agent qa-reviewer : périmètre d’un lot et lecture du DOM en texte d’abord (L123)', () => {
    const qa = qaAgent();
    const scope = qa.section('Scope of a lot');
    // Trois ensembles de pages, pas plus : endpoints changés, pages du lot visible, accueil.
    expect(scope).toContain('walk only the pages the lot touched');
    expect(scope).toContain('the pages that call the changed endpoints');
    expect(scope).toContain('the pages of the screens the lot changed');
    expect(scope).toContain('the home page');
    // Le cas qui coûte : un lot backend qui vide une page, sans écran touché.
    expect(scope).toContain('A backend-only lot is kept in scope');
    expect(scope).toContain('can empty a page without touching a screen');
    // Un périmètre qui ne se déduit pas ne réduit rien : passage complet, dit.
    expect(scope).toContain('If you cannot tell which pages a changed endpoint feeds, walk every page');
    // Lot backend qui ne change aucune route : repli explicite et obligatoire, dit dans le rapport.
    expect(scope).toContain('If the lot changes no route');
    expect(scope).toContain('the fallback is mandatory: walk every page and say so in the report');
    // Un lot backend touche aussi les pages qui consomment les services modifiés (grep des appels).
    expect(scope).toContain('the pages that consume the services the lot changed');
    expect(scope).toContain('grep for their callers');
    // Les pages hors périmètre sont nommées, jamais comptées comme vérifiées.
    expect(scope).toContain('named under « Not walked », never counted as checked');
    // Sans lot : tout est parcouru.
    expect(scope).toContain('Without a lot id, walk every page');
    // Texte d'abord, capture sur écart seulement.
    const method = qa.section('Method');
    expect(method).toContain('read the page as text first');
    expect(method).toContain('take a capture only for a gap');
    expect(method).toContain('a page that matches its expectations gets none');
    // Le rapport permet de mesurer avant/après.
    const output = qa.section('Output');
    expect(output).toContain('**Scope**');
    expect(output).toContain('pages walked of pages in the expectations');
    expect(output).toContain('captures taken');
  });

  it('les skills lead et session-close nomment la porte de revue de code', () => {
    const skill = (name: string) => readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    expect(skill('lead')).toContain('The `code-reviewer` agent');
    expect(skill('lead')).toContain('`raf review <lot> "…"`');
    // Le brief du lead vit dans le gabarit d'orchestrate (source unique), que le skill cite.
    expect(skill('lead')).toContain('templates/orchestrate/implement.md');
    expect(readFileSync(join(SKILLS_DIR, '../templates/orchestrate/implement.md'), 'utf8')).toContain('do not push, deliver, run `raf done`, `raf ux` or\n`raf review`.');
    expect(skill('session-close')).toContain('`raf review <id> "…"`');
  });

  it('le skill lead délègue à la main à partir du brief rendu par --dry-run ({{news}} compris), sans liste de variables à remplir (L48/t1)', () => {
    const lead = skillText('lead');
    expect(lead).toContain('cadence orchestrate --dry-run <project>:<lot>');
    expect(lead).toContain('already rendered');
    expect(lead).toContain('{{news}}');
    expect(lead).not.toContain('fills `{{chemin}}`');
  });

  it('le skill lead nomme la tâche de fond, lance la vague avec --wave et arme un suivi sur le journal, sans boucle d’attente (L49)', () => {
    const lead = skillText('lead');
    expect(lead).toContain('« vague `<id>` : `<project>:<lot>`, … »');
    expect(lead).toContain('--wave <id>');
    expect(lead).toContain('tail -n +1 -F .cadence/runs/<id>/journal.log');
    expect(lead).toContain('Monitor');
    expect(lead).toContain('cadence orchestrate --status --watch');
    expect(lead).not.toContain('handed back, final table');
    expect(lead).toContain('The final table is not in the journal');
    expect(lead).toContain('stop the follow-up');
    const readme = flat(readFileSync(join(AGENTS_DIR, '..', 'README.md'), 'utf8'));
    expect(readme).toContain('--status [<wave>] --watch [--interval 10]');
    expect(readme).toContain('.cadence/runs/<id>/journal.log');
  });

  it('les skills lead et deliver font suivre par l’agent qa-reviewer toute livraison qui change ce qu’une page montre ou reçoit ; session-start n’en parle pas', () => {
    const skill = (name: string) => readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    const lead = skill('lead');
    // Étape 4 du lead : après la livraison, pas avant ; les constats bloquants remontent à l'humain.
    const delivery = lead.slice(lead.indexOf('## 4. Delivery'), lead.indexOf('## 5. Close'));
    expect(delivery).toContain(`After a green delivery that ${QA_TRIGGER} — have the \`qa-reviewer\` agent check the delivered app, as a fresh subagent`);
    expect(delivery).toContain('give it the absolute path of the project, the base URL of the delivered app and the lot id.');
    // Les deux pannes à l'origine de l'agent venaient de lots sans écran : le lot n'a pas à être « visible ».
    expect(delivery).toContain('The lot need not be `visible`: a backend-only lot can empty a page without changing a screen.');
    expect(delivery).toContain('With a lot id, the agent walks only the pages the lot touched (the pages that call the changed endpoints, the pages of the changed screens, the home page) and names the others under « Not walked »: they are not checked.');
    expect(delivery).not.toContain('lot marked `visible`');
    expect(delivery).toContain('Bring its blocking findings back to the human');
    expect(delivery).toContain('it reads only, and never logs in');
    // Ce n'est pas une porte : raf done ne l'attend pas, un constat devient un nouveau lot.
    expect(delivery).toContain('It is not a gate: `raf done` does not wait for it, and a finding becomes a new lot, not a reopened one.');
    expect(delivery).toContain('A project without an expectations file gets a draft back: show it to the human, who corrects it and decides whether it is committed.');
    expect(delivery).toContain("It walks the pages in a real browser against the project's expectations (`docs/qa/expectations.md`: per page, what the user must find there) and returns measured findings;");
    expect(delivery).toContain('Bring its blocking findings back to the human — a page whose main content is missing, or that shows an error, is a defect even when the delivery checks are green — with its proposed follow-up lines.');
    const deliver = skill('deliver');
    const step = deliver.slice(deliver.indexOf(' 6. '), deliver.indexOf('## Rules'));
    expect(step).toContain(`After a green delivery that ${QA_TRIGGER} — have the \`qa-reviewer\` agent walk the delivered app in a real browser, whether the lot is \`visible\` or not:`);
    expect(step).toContain('With a lot id, the agent walks only the pages the lot touched (the pages that call the changed endpoints, the pages of the changed screens, the home page) and names the others under « Not walked »: they are not checked.');
    expect(step).not.toContain('delivery of a `visible` lot');
    // Ses entrées, la remontée des constats bloquants, et la livraison qui reste faite.
    expect(step).toContain('give it the repository path, the base URL and the lot id.');
    expect(step).toContain('It checks each page against `docs/qa/expectations.md` — what the user must find there — and reports a page left empty, an error shown, an API call that failed or came back empty: what the checks of `cadence.yaml` do not see.');
    expect(step).toContain('Bring its blocking findings to the human.');
    expect(step).toContain('It is not a gate: the delivery stays done, a finding becomes a new lot.');
    // La re-vérification périodique par commande est un autre lot (L8).
    expect(skill('session-start')).not.toContain('qa-reviewer');
  });

  it('README : section QA review — le format des attentes est celui que lit l’agent, la clé qa.expectations est documentée', () => {
    const root = join(AGENTS_DIR, '..');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const agent = readFileSync(join(AGENTS_DIR, 'qa-reviewer.md'), 'utf8');
    const section = readme.slice(readme.indexOf('### QA review'), readme.indexOf('## session'));
    expect(readme.indexOf('### Code review')).toBeLessThan(readme.indexOf('### QA review'));
    expect(section).toContain('`docs/qa/expectations.md`');
    expect(section).toContain('qa:\n  expectations: ');
    // Les trois sortes de lignes d'une page : mêmes mots dans l'exemple du README et dans le contrat de l'agent.
    expect(section).toMatch(/^## \/players$/m);
    for (const key of ['shows:', 'never:', 'api:']) {
      expect(section).toMatch(new RegExp(`^- ${key} `, 'm'));
      expect(agent).toContain(`\`${key}\``);
    }
    expect(agent).toContain('One `## <route>` section per page');
    const text = flat(section);
    expect(text).toContain('No gate and no command here: the QA review comes **after** a delivery, and `raf done` does not wait for it.');
    expect(text).toContain(`It follows any delivery that ${QA_TRIGGER}:`);
    expect(text).toContain('a backend-only lot can empty a page without touching a screen, and the agent then walks the pages that call the changed endpoints.');
    const skills = flat(readme.slice(readme.indexOf('## Claude Code skills'), readme.indexOf('## Releasing')));
    expect(skills).toContain('after a green delivery that changes what a page shows or what it is served, the `qa-reviewer` agent walks the delivered app.');
    expect(skills).toContain('a delivery that changes what a page shows or what it is served is then checked in the running app by the `qa-reviewer` agent, whose blocking findings come back to you.');
    expect(skills).toContain('optionally a lot id, to walk only the pages it touched — those that call the changed endpoints, those of the screens it changed, and the home page; a backend-only lot stays in scope');
    expect(skills).not.toMatch(/visible lot[^.]*qa-reviewer/);
    // Les trois sortes de constat, comme dans le contrat de l'agent.
    expect(skills).toContain('Findings are defects (a line of the expectations broken, or a universal check failing with a visible effect, with or without an expectations file), suspects (it looks like missing or wrong data and no expectation settles it) or noise (a console error or a failed request with no visible effect, ranked minor)');
    expect(skills).toContain('Read-only: GET only, no login, nothing submitted; it stops at a PIN.');
    expect(skills).toContain("it opens each page of the project's expectations file in a real browser at 1440 and 390 px and measures: expected content present and non-empty, no error or missing-data message, every API call answered 2xx with a non-empty body, no console error, no broken content image.");
    expect(skills).toContain('ranked, each with the route, what was expected, what was measured and the evidence; pages checked N/N, follow-ups as `raf add` lines, what it could not verify, a one-line verdict.');
    expect(text).toContain("The `qa-reviewer` agent opens each page of the running app in a real browser and judges it from the user's side. A page can be empty while everything else is green — no code changed, a data source went down upstream, the unit tests replace the network, `/api/health` answers ok, and the \"nothing found\" on screen is the message the code was written to show.");
    expect(text).toContain('The agent cannot tell such an empty state from a normal one by itself: the project says what each page must show, in `docs/qa/expectations.md` — one `## <route>` section per page, three kinds of lines:');
    expect(text).toContain('The rest is free text, written for a reader: a line can be repeated, and');
    // La définition des trois sortes de lignes.
    expect(text).toContain('- `shows:` — content that must be present and non-empty, with a count where one exists;');
    expect(text).toContain('- `never:` — texts that must not appear: error messages, and empty-state messages that mean missing data;');
    expect(text).toContain('- `api:` — the calls the page depends on: each must answer 2xx with a non-empty body (a 200 with `[]`, `{}` or `null` is a failure, unless its line says `may be empty when …`).');
    // Le format : mêmes clauses dans le README et dans le contrat de l'agent, qui ne dit plus « where data is expected ».
    const qa = qaAgent();
    for (const clause of QA_FORMAT) {
      expect(text).toContain(clause);
      expect(qa.section('Method')).toContain(clause);
    }
    expect(qa.body).not.toContain('where data is expected');
    expect(text).toContain('A line may end with a condition in plain words, which the agent honours:');
    expect(qa.section('Method')).toContain('A line may end with a condition in plain words, which you honour:');
    // L'exemple montre la section commune et les deux sortes de condition.
    expect(section).toMatch(/^## \*$/m);
    expect(section).toMatch(/^- api: .+ — may be empty when .+$/m);
    expect(section).toMatch(/^- shows: .+ — 1440 only$/m);
    // Route à paramètre sans fichier : une vraie valeur, et la façon dont l'URL a été construite.
    expect(text).toContain("For a route with a parameter, it finds a real value in the app's links or its API responses and says how it built the URL.");
    expect(qa.section('Method')).toContain("for a route with a parameter, find a real value in the app's links or its API responses and say how you built the URL");
    expect(qa.section('Method')).toContain('A route with a parameter names a real value to visit, or says where to find one.');
    expect(text).toContain('a route with a parameter names a real value to visit or says where to find one');
    // Le brouillon revient à l'humain : l'agent n'écrit jamais le fichier.
    expect(text).toContain('returns a draft for you to correct — it never writes the file itself.');
    // Sans fichier : mêmes règles que dans le contrat de l'agent.
    expect(text).toContain('Without an expectations file the agent walks the routes it discovers and still runs its universal checks: an error shown, a failed API call whose content is missing on screen, a broken or missing content image are defects with or without a file; an empty 2xx body, like whatever else would need an expectation to judge, is suspect at most (it may be a normal absence).');
    expect(text).toContain('The agent reads that key, and so does `raf check`: a commit touching only that file is plan upkeep (no lot to cite, see above).');
    expect(readme).toContain('`ux-reviewer`, `code-reviewer` and `qa-reviewer` agents');
    expect(readme).toContain('- **qa-reviewer** (agent)');
  });

  it('un mineur ne devient un lot que s’il décrit un bug observable ; sinon il reste une note du lot d’origine (L109)', () => {
    const lead = skillText('lead');
    expect(lead).toContain(MINOR_RULE);
    for (const t of ['review', 'review-small', 'review-recheck', 'ux']) {
      expect(flat(readFileSync(join(SKILLS_DIR, '../templates/orchestrate', `${t}.md`), 'utf8'))).toContain(MINOR_RULE_BRIEF);
    }
    for (const a of ['code-reviewer', 'ux-reviewer']) {
      expect(flat(readFileSync(join(AGENTS_DIR, `${a}.md`), 'utf8'))).toContain(MINOR_RULE_BRIEF);
    }
  });

  it('manifestes : trois agents relecteurs annoncés, et la même version aux quatre endroits', () => {
    const root = join(AGENTS_DIR, '..');
    const json = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
    const version = json('package.json').version;
    expect(json('.claude-plugin/plugin.json').description).toContain('three reviewer agents (UX, code, QA)');
    expect(json('.claude-plugin/plugin.json').version).toBe(version);
    expect(json('.claude-plugin/marketplace.json').plugins[0].version).toBe(version);
    expect(json('package-lock.json').version).toBe(version);
    expect(json('package-lock.json').packages[''].version).toBe(version);
  });
});
