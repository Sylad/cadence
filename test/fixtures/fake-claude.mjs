#!/usr/bin/env node
// Faux `claude` des tests de bout en bout (CADENCE_CLAUDE_BIN). Lit un scénario JSON (FAKE_CLAUDE_SCENARIO) :
// { "<étape>": [ action, … ] } consommé dans l'ordre, une action par appel de cette étape.
// action : { commits: [{file, message}], structured, tokens, exit, garbage, sleepMs, push, usageLimit }
// "{lot}" dans un message est remplacé par le lot du brief. Chaque appel est journalisé (FAKE_CLAUDE_LOG).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('9.9.9 (Fake Claude Code)');
  process.exit(0);
}
if (argv[0] === '--help') {
  console.log('  --json-schema <schema>   JSON Schema for structured output');
  process.exit(0);
}

const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const brief = argv[1];
const agent = flag('--agent');
const kind = agent === 'ux-reviewer' ? 'ux' : agent === 'code-reviewer' ? (brief.includes('single pass') ? 'review-small' : 'review') : brief.includes('found the defects below') ? 'fix' : 'implement';
const lot = /on lot `([^`]+)`|[Rr]eview lot `([^`]+)`|of lot `([^`]+)`/.exec(brief)?.slice(1).find(Boolean) ?? '?';

const scenarioFile = process.env.FAKE_CLAUDE_SCENARIO;
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const stateFile = `${scenarioFile}.state`;
const used = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const index = used[kind] ?? 0;
used[kind] = index + 1;
writeFileSync(stateFile, JSON.stringify(used));
const action = (scenario[kind] ?? [])[index] ?? scenario[`${kind}*`] ?? {};

const entry = { kind, lot, cwd: process.cwd(), model: flag('--model'), orchestrated: process.env.CADENCE_ORCHESTRATED ?? null, resume: argv.includes('--resume'), sessionId: flag('--session-id') };
const commits = [];
for (const c of action.commits ?? []) {
  writeFileSync(join(process.cwd(), c.file), `${Math.random()}\n`);
  spawnSync('git', ['add', '--', c.file], { cwd: process.cwd() });
  const message = c.message.replaceAll('{lot}', lot);
  spawnSync('git', ['commit', '-q', '-m', message, '--', c.file], { cwd: process.cwd() });
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim();
  commits.push({ sha, sujet: message });
}
if (action.push) entry.pushStatus = spawnSync('git', ['push', '-q'], { cwd: process.cwd(), encoding: 'utf8' }).status;
appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);

if (action.sleepMs) await new Promise((r) => setTimeout(r, action.sleepMs));
if (action.garbage) {
  console.log('ceci n\'est pas du JSON');
  process.exit(action.exit ?? 0);
}

const sample = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SAMPLE, 'utf8'));
const t = action.tokens ?? {};
const structured = action.structured ?? (kind === 'implement' || kind === 'fix'
  ? { commits, tests: { commande: 'npm test', resultat: 'ok', vert: true }, build: { commande: 'npm run build', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'fait' }
  : { bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: 'conforme' });
const out = {
  ...sample,
  session_id: `fake-${kind}-${index}`,
  usage: { ...sample.usage, input_tokens: t.input ?? 10, cache_creation_input_tokens: t.cacheWrite ?? 100, cache_read_input_tokens: t.cacheRead ?? 1000, output_tokens: t.output ?? 5 },
};
if (action.usageLimit) {
  Object.assign(out, { is_error: true, result: 'Claude AI usage limit reached|1759600000' });
  delete out.structured_output;
  console.log(JSON.stringify(out));
  process.exit(1);
}
out.structured_output = structured;
out.result = JSON.stringify(structured);
console.log(JSON.stringify(out));
process.exit(action.exit ?? 0);
