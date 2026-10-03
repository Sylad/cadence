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
    ]) expect(text).toContain(clause);
  });

  it('CLI : installe aussi l’agent qa-reviewer, sans liste d’outils (le navigateur disponible dépend de l’installation)', async () => {
    const dir = gitRepo();
    const out: string[] = [];
    const code = await run(['skills', 'install'], { cwd: dir, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('cadence-qa-reviewer (agent) : installé');
    const agent = readFileSync(join(dir, '.claude/agents/cadence-qa-reviewer.md'), 'utf8');
    expect(agent).toMatch(/^---\nname: cadence-qa-reviewer\ndescription: .+\n---\n/);
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
      'Optionally a lot id: then start with the pages that lot touched',
      // Le fichier d'attentes, et son absence.
      '`docs/qa/expectations.md`, or the file named by `qa.expectations` in `cadence.yaml`',
      'No expectations file: do not guess silently',
      'Return a DRAFT expectations file as text',
      'without expectations an empty state cannot be told from a normal one',
      // Ce qui se mesure, aux deux largeurs.
      'in a real browser',
      'at **1440 px** and **390 px** wide',
      'answered 2xx with a non-empty body where data is expected',
      'A 200 with an empty or null body',
      'is a failure',
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
    expect(method).toContain('- *defect* — a line of the expectations is broken, or a universal check fails with a visible effect on the page: an error message shown, a failed or empty API call whose content is missing on screen, a broken or missing content image. Universal checks need no expectations file: such a failure is a defect even without one;');
    expect(method).toContain('- *suspect* — something that looks like missing or wrong data and that no expectation settles: an empty list under a heading, a "nothing found" message, a status or label contradicted by the page\'s own data ("eliminated" beside a won match), a stale season label. Say why, and propose the line of expectations that would settle it;');
    expect(method).toContain('- *noise* — a console error or a failed request with no visible effect: reported, ranked minor;');
    expect(method).toContain('- *out of scope* — usability and accessibility belong to `ux-reviewer`, code quality to `code-reviewer`: one line at most, never a finding.');
    // Les trois rangs ; un contenu faux compte comme un contenu manquant.
    expect(method).toContain("**Rank** each finding: *blocking* (a page's main content is missing, its main information is false, or an error is shown to the user), *major* (secondary content missing or wrong, a section the page silently drops after a failed or empty API call, a broken content image), *minor* (noise: a console error or a failed request with no visible effect).");
    // Sans fichier d'attentes : les vérifications universelles tiennent, le reste est suspect au plus.
    expect(method).toContain('report what you saw: the universal checks hold without a file, and anything that would need an expectation to judge is *suspect* at most.');
    expect(method).toContain('Say plainly that without expectations an empty state cannot be told from a normal one.');
    expect(method).not.toContain('never *defect*');
    const output = qa.section('Output');
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
    expect(qa.description).toContain('without an expectations file it still runs its universal checks, reports what it saw and returns a draft one.');
    expect(qa.description).toContain('reports empty states, wrong data, error messages, failed or empty API calls, console errors and broken images.');
    // Déclencheur : toute livraison qui change ce qu'une page montre ou reçoit — pas seulement un lot « visible ».
    expect(qa.description).toContain(`Use after any delivery that ${QA_TRIGGER} — or to re-check a deployed app.`);
    expect(qa.description + qa.body).not.toContain('`visible`');
    expect(qa.section('Inputs')).toContain('then start with the pages that lot touched (its title and notes in the plan, and `raf commits <id>`, tell which) — when the lot touched only the backend, the pages that call the changed endpoints — and walk the others after.');
    expect(qa.description).toContain('Read-only — does not modify code, log in or submit anything.');
  });

  it('les skills lead et session-close nomment la porte de revue de code', () => {
    const skill = (name: string) => readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    expect(skill('lead')).toContain('The `code-reviewer` agent');
    expect(skill('lead')).toContain('`raf review <lot> "…"`');
    expect(skill('lead')).toContain('do not push, deliver, run `raf done`, `raf ux` or\n> `raf review`.');
    expect(skill('session-close')).toContain('`raf review <id> "…"`');
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
    expect(delivery).toContain('When the lot touched only the backend, the agent starts with the pages that call the changed endpoints.');
    expect(delivery).not.toContain('lot marked `visible`');
    expect(delivery).toContain('Bring its blocking findings back to the human');
    expect(delivery).toContain('it reads only, and never logs in');
    // Ce n'est pas une porte : raf done ne l'attend pas, un constat devient un nouveau lot.
    expect(delivery).toContain('It is not a gate: `raf done` does not wait for it, and a finding becomes a new lot, not a reopened one.');
    expect(delivery).toContain('show it to the human, who corrects it and decides whether it is committed');
    const deliver = skill('deliver');
    const step = deliver.slice(deliver.indexOf(' 6. '), deliver.indexOf('## Rules'));
    expect(step).toContain(`After a green delivery that ${QA_TRIGGER} — have the \`qa-reviewer\` agent walk the delivered app in a real browser, whether the lot is \`visible\` or not:`);
    expect(step).toContain('When the lot touched only the backend, the agent starts with the pages that call the changed endpoints.');
    expect(step).not.toContain('delivery of a `visible` lot');
    // Ses entrées, la remontée des constats bloquants, et la livraison qui reste faite.
    expect(step).toContain('give it the repository path, the base URL and the lot id.');
    expect(step).toContain('`docs/qa/expectations.md`');
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
    expect(text).toContain('a backend-only lot can empty a page without touching a screen, and the agent then starts with the pages that call the changed endpoints.');
    const skills = flat(readme.slice(readme.indexOf('## Claude Code skills'), readme.indexOf('## Releasing')));
    expect(skills).toContain('after a green delivery that changes what a page shows or what it is served, the `qa-reviewer` agent walks the delivered app.');
    expect(skills).toContain('a delivery that changes what a page shows or what it is served is then checked in the running app by the `qa-reviewer` agent, whose blocking findings come back to you.');
    expect(skills).toContain('optionally a lot id, to start with the pages it touched — for a backend-only lot, those that call the changed endpoints');
    expect(skills).not.toMatch(/visible lot[^.]*qa-reviewer/);
    // Les trois sortes de constat, comme dans le contrat de l'agent.
    expect(skills).toContain('Findings are defects (a line of the expectations broken, or a universal check failing with a visible effect, with or without an expectations file), suspects (it looks like missing or wrong data and no expectation settles it) or noise (a console error or a failed request with no visible effect, ranked minor)');
    expect(skills).toContain('Read-only: GET only, no login, nothing submitted; it stops at a PIN.');
    // La définition des trois sortes de lignes.
    expect(text).toContain('- `shows:` — content that must be present and non-empty, with a count where one exists;');
    expect(text).toContain('- `never:` — texts that must not appear: error messages, and empty-state messages that mean missing data;');
    expect(text).toContain('- `api:` — the calls the page depends on: each must answer 2xx with a non-empty body (a 200 with `[]`, `{}` or `null` is a failure).');
    expect(text).toContain('a route with a parameter names a real value to visit or says where to find one');
    // Le brouillon revient à l'humain : l'agent n'écrit jamais le fichier.
    expect(text).toContain('returns a draft for you to correct — it never writes the file itself.');
    // Sans fichier : mêmes règles que dans le contrat de l'agent.
    expect(text).toContain('Without an expectations file the agent walks the routes it discovers and still runs its universal checks: an error shown, a failed or empty API call whose content is missing on screen, a broken or missing content image are defects with or without a file; whatever would need an expectation to judge is suspect at most.');
    expect(text).toContain('Only the agent reads that key; the CLI does not use it.');
    expect(readme).toContain('`ux-reviewer`, `code-reviewer` and `qa-reviewer` agents');
    expect(readme).toContain('- **qa-reviewer** (agent)');
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
