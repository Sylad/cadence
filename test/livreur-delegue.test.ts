import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// L439 : l'agent livreur (fiche docs/specs/livreur-delegue/fiche.yaml) et ce que le skill lead en dit.
const root = join(import.meta.dirname, '..')
const flat = (s: string) => s.replace(/\s+/g, ' ')
const raw = readFileSync(join(root, 'agents/livreur.md'), 'utf8')
const end = raw.indexOf('\n---\n', 4)
const header = raw.slice(0, end)
const body = flat(raw.slice(end + 5))
const lead = flat(readFileSync(join(root, 'skills/lead/SKILL.md'), 'utf8'))
const section = (title: string): string => {
  const start = raw.indexOf(`\n## ${title}`)
  if (start < 0) throw new Error(`section « ${title} » absente de agents/livreur.md`)
  const next = raw.indexOf('\n## ', start + 4)
  return flat(raw.slice(start, next < 0 ? undefined : next))
}
const before = (text: string, a: string, b: string) => {
  const i = text.indexOf(a)
  const j = text.indexOf(b)
  expect(i, a).toBeGreaterThan(-1)
  expect(j, b).toBeGreaterThan(-1)
  expect(i, `${a} avant ${b}`).toBeLessThan(j)
}

describe('agent livreur (L439)', () => {
  it('R1 — agents/livreur.md demande un seul lot et un sha dans le brief, et interdit d\'en traiter un second', () => {
    expect(body).toMatch(/ONE lot per launch/)
    expect(body).toContain('the lot of the brief, at the sha of the brief')
    expect(body).toMatch(/never a second lot/)
    expect(body).toMatch(/never work out the « livrable jusqu'à » sha/)
  })

  it('le front matter de agents/livreur.md est du YAML valide (name, description, tools)', () => {
    const fm = parse(header.slice(4)) as Record<string, unknown>
    expect(fm.name).toBe('livreur')
    expect(typeof fm.description).toBe('string')
    expect(fm.tools).toBe('Read, Grep, Glob, Bash')
  })

  it('R2 — agents/livreur.md n\'a pas l\'outil Agent et dit de rendre une question au lead au lieu de demander', () => {
    const tools = /^tools: (.+)$/m.exec(header)?.[1] ?? ''
    expect(tools).not.toMatch(/\bAgent\b|\bTask\b|AskUserQuestion/)
    expect(tools).not.toMatch(/\bEdit\b|\bWrite\b/)
    expect(body).toMatch(/launch no agent/i)
    expect(body).toMatch(/ask the human nothing/i)
    expect(body).toMatch(/hand it back to the lead as a question/)
  })

  it('R3 — agents/livreur.md liste les étapes dans l\'ordre verify, UX, raf done, push, deliver', () => {
    const chain = section('The chain')
    before(chain, 'cadence verify --gate --sha <sha>', 'raf ux')
    before(chain, 'raf ux', 'raf done <lot>')
    before(chain, 'raf done <lot>', 'git push origin <sha>:main')
    before(chain, 'git push origin <sha>:main', 'cadence deliver --dry-run --sha <sha>')
    before(chain, 'cadence deliver --dry-run --sha <sha>', 'cadence deliver --sha <sha>')
    expect(chain).toMatch(/commit of the plan/i)
    before(chain, 'raf done <lot>', 'commit of the plan')
    before(chain, 'commit of the plan', 'git push origin <sha>:main')
  })

  it('R4 — agents/livreur.md interdit raf done, push et deliver après un verify rouge ou 2', () => {
    const chain = section('The chain')
    expect(chain).toMatch(/exit 1 \(red\) or 2 \(nothing to replay\): run neither `raf done`, nor a push, nor `cadence deliver`/i)
  })

  it('R4 — agents/livreur.md distingue le contenu de la question du code 1 (tests en échec) et du code 2 (rien à rejouer)', () => {
    const chain = section('The chain')
    expect(chain).toContain('Question : verify --gate rouge au sha <sha> : <tests en échec>')
    expect(chain).toContain('Question : verify --gate au sha <sha> : rien à rejouer (code 2)')
  })

  it('R4 — le code de sortie du verify est lu sans pipe (pas de | tail)', () => {
    const chain = section('The chain')
    expect(chain).toMatch(/exit code[^.]*without a pipe/)
    expect(raw).not.toMatch(/cadence verify --gate[^\n`]*\|/)
  })

  it('R5 — agents/livreur.md demande d\'ouvrir les captures et d\'enregistrer raf ux seulement sans réserve', () => {
    const ux = section('The UX verdict')
    expect(ux).toContain('`lead.ux: lead`')
    expect(ux).toMatch(/open the captures yourself/)
    expect(ux).toMatch(/do not trust the words of the report/)
    expect(ux).toMatch(/only when the reviewer has no reservation left and the captures show what the lot promised/)
    expect(ux).toContain('raf ux <lot> "…"')
  })

  it('R6 — agents/livreur.md rend une question sans raf ux quand le brief n\'a pas les captures', () => {
    const ux = section('The UX verdict')
    expect(ux).toMatch(/slightest doubt/)
    for (const d of ['reservation you cannot settle', 'capture you cannot read', 'matter of taste', 'state the captures do not show', 'report or captures missing from the brief']) {
      expect(ux, d).toContain(d)
    }
    expect(ux).toContain('Question : doute sur le verdict UX de <lot> : <réserve> (captures : <chemin>)')
    expect(ux).toMatch(/records no `raf ux`, closes nothing/)
  })

  it('R7 — agents/livreur.md interdit raf ux quand lead.ux n\'est pas lead', () => {
    const ux = section('The UX verdict')
    expect(ux).toMatch(/`lead\.ux: human` \(or no key\): never form the verdict/)
    expect(ux).toContain('Question : verdict UX absent pour <lot> (lead.ux: human)')
  })

  it('R7 — agents/livreur.md lit raf show pour savoir si un verdict UX existe', () => {
    expect(section('The UX verdict')).toContain('`raf show <lot>`')
  })

  it('R8 — agents/livreur.md prend l\'URL dans le brief et interdit de l\'inventer', () => {
    const line = section('The line')
    expect(line).toMatch(/base URL .* from the brief/)
    expect(line).toMatch(/never deduce or invent it/)
  })

  it('R8 — agents/livreur.md juge l\'absence de QA sur git diff --name-only origin/main..<sha> (docs, plan, tests seuls)', () => {
    const line = section('The line')
    expect(line).toContain('git diff --name-only origin/main..<sha>')
    expect(line).toMatch(/docs, the plan or tests only/)
    expect(line).toMatch(/whole interval/)
  })

  it('R8 — agents/livreur.md garde l\'URL quand un commit antérieur de l\'intervalle change une page ou une API et que le dernier ne touche que des tests ou des docs', () => {
    const line = section('The line')
    expect(line).toMatch(/not the last commit alone/)
    expect(line).toMatch(/an earlier commit of the lot may change a page or an API/)
    expect(line).toMatch(/one file of the interval touches a page or an API: the line carries the URL/)
  })

  it('R8 — agents/livreur.md donne le format exact de la ligne avec l\'URL', () => {
    expect(section('The line')).toContain('<lot> livré <sha court>, QA à lancer <url>')
  })

  it('R8 — agents/livreur.md donne la variante sans QA pour une livraison docs, plan ou tests seuls', () => {
    expect(section('The line')).toContain('<lot> livré <sha court>, pas de QA à lancer')
  })

  it('R9 — agents/livreur.md interdit de lancer le qa-reviewer', () => {
    expect(body).toMatch(/never launch the `qa-reviewer`/)
    expect(body).toMatch(/the lead launches it after your line/)
  })

  it('R9 — skills/lead/SKILL.md fait lancer le qa-reviewer par le lead après la ligne du livreur', () => {
    expect(lead).toMatch(/the lead itself launches the `qa-reviewer` with the URL of the line/)
  })

  it('R10 — agents/livreur.md reprend le commit imprimé par raf done', () => {
    const chain = section('The chain')
    expect(chain).toMatch(/exactly the `git add` \/ `git commit` command that `raf done` prints \(same paths, same subject\)/)
    expect(chain).toMatch(/do not push the commit of the plan/i)
  })

  it('R10 — agents/livreur.md pousse <sha>:main et jamais HEAD', () => {
    const chain = section('The chain')
    expect(chain).toContain('git push origin <sha>:main')
    expect(chain).toMatch(/never `HEAD`/)
  })

  it('R10 — agents/livreur.md interdit --force et CADENCE_PUSH_UNGATED', () => {
    expect(body).toContain('`--force`')
    expect(body).toContain('`CADENCE_PUSH_UNGATED`')
    expect(body).toMatch(/no second attempt after a refusal \(`raf done`, `pre-push` hook exit 3, `cadence deliver`\)/)
  })

  it('R11 — agents/livreur.md commite le plan aussitôt si raf done avertit d\'une intégration en cours', () => {
    expect(section('The chain')).toMatch(/« intégration en cours »: commit the plan at once, with no other write in the tree/)
  })

  it('R12 — agents/livreur.md interdit raf review et toute modification de code', () => {
    expect(body).toMatch(/never `raf review`, never `raf start`/)
    expect(body).toMatch(/never change code/i)
    expect(body).toMatch(/`raf ux` only in the case of the UX verdict/)
  })

  it('R13 — agents/livreur.md impose le préfixe « Question : »', () => {
    expect(section('Questions')).toContain('starts with « Question : »')
  })

  it('R13 — agents/livreur.md impose de nommer l\'étape atteinte et le sha', () => {
    const q = section('Questions')
    expect(q).toMatch(/the step reached/)
    expect(q).toMatch(/the sha/)
    expect(q).toMatch(/state of the repository left by that step/)
  })

  it('R13 — agents/livreur.md impose de donner la commande à relancer', () => {
    expect(section('Questions')).toMatch(/the cause and the command to rerun/)
  })

  it('R14 — agents/livreur.md rend une question sans rien lancer quand le sha, le lot, le dossier ou lead.ux manque au brief', () => {
    const c = section('Before any command')
    expect(c).toMatch(/launch neither verify, nor `raf done`, nor a push, nor deliver/)
    for (const f of ['project folder', 'lot id', 'sha', '`lead.ux` value', 'base URL', 'report or captures']) {
      expect(c, f).toContain(f)
    }
    expect(c).toContain('Question : brief incomplet : <champ> absent')
  })

  it('R14 — agents/livreur.md rend une question quand le lot est inconnu ou déjà done', () => {
    const c = section('Before any command')
    expect(c).toMatch(/lot unknown to the plan/)
    expect(c).toContain('Question : <lot> déjà clos ou sha <sha> déjà livré (origin/main et journal)')
  })

  it('R14 — agents/livreur.md exige git merge-base --is-ancestor <sha> HEAD et rend une question sinon', () => {
    const c = section('Before any command')
    expect(c).toContain('git merge-base --is-ancestor <sha> HEAD')
    expect(c).toContain('Question : sha <sha> non livrable : pas un ancêtre de HEAD')
  })

  it('R14 — agents/livreur.md rend une question qui nomme le lot non prêt quand un commit d\'un autre lot non done est sous le sha', () => {
    const c = section('Before any command')
    expect(c).toMatch(/between `origin\/main` and the sha cites a lot other than the lot of the brief that is not done \(ready but not yet done counts too\)/)
    expect(c).toContain('Question : sha <sha> non livrable : commit du lot <autre> non prêt dessous')
  })

  it('R14 — agents/livreur.md définit « sha déjà livré » comme ancêtre de origin/main ET présent au journal deliveries.log', () => {
    const c = section('Before any command')
    expect(c).toContain('git fetch origin main')
    expect(c).toMatch(/ancestor of `origin\/main` AND present in the delivery log/)
    expect(c).toContain('deliveries.log')
    expect(c).toContain('git rev-parse --git-common-dir')
    expect(c).toMatch(/full sha or its prefix/)
  })

  it('R14 — agents/livreur.md rend une question qui dit quelle preuve manque quand une seule des deux est vraie', () => {
    const c = section('Before any command')
    expect(c).toMatch(/only one of the two[^.]*which proof is missing/i)
    expect(c).toContain('Question : sha <sha> non livrable : dans origin/main sans le journal')
    expect(c).toContain('Question : sha <sha> non livrable : au journal sans être dans origin/main')
    expect(c).toMatch(/sha declared by the delivery script/)
  })

  it('R14 — agents/livreur.md pèse les deux preuves avant de répondre « déjà clos » pour un lot done (relance après un deliver refusé)', () => {
    const c = section('Before any command')
    const lot = c.indexOf('2. The lot')
    const preuves = c.indexOf('6. The sha is not already delivered')
    expect(lot).toBeGreaterThan(-1)
    // le contrôle du lot ne rend plus « déjà clos » : seul le contrôle des deux preuves le fait
    expect(c.slice(lot, c.indexOf('3. Run')).includes('Question : <lot> déjà clos')).toBe(false)
    expect(c.slice(preuves)).toMatch(/Lot done and neither proof/)
    expect(c.slice(preuves)).toMatch(/lot being done does not change the choice of the message/)
  })

  it('R14 — agents/livreur.md refuse un sha déjà dans origin/main sans le journal sans relancer raf done ni deliver', () => {
    const c = section('Before any command')
    expect(c).toMatch(/rerun nothing: neither `raf done` nor `cadence deliver`/)
    expect(c).toMatch(/after a successful delivery never does `raf done` again/)
  })

  it('une étape qui échoue (fetch, raf done, commit, push, deliver) devient « <étape> refusée au sha <sha> »', () => {
    expect(section('Questions')).toContain('Question : <étape> refusée au sha <sha> : <message de la commande>')
    expect(section('Before any command')).toMatch(/`git fetch origin main` fails/)
  })
})

describe('skills/lead/SKILL.md et documentation — livreur délégué (L439)', () => {
  it('R11 — skills/lead/SKILL.md dit une livraison à la fois et compte le livreur dans le plafond', () => {
    expect(lead).toMatch(/one `livreur` at a time: never two deliveries in parallel/)
    expect(lead).toMatch(/counts in the cap of subagents/)
  })

  it('R11 — skills/lead/SKILL.md dit que seuls livreurs et sous-agents bloquent un nouveau livreur, pas les sessions de vague', () => {
    expect(lead).toMatch(/only another `livreur` or another subagent blocks a new one; the sessions of a running wave do not/i)
  })

  it('R11 — skills/lead/SKILL.md interdit de lancer un livreur pendant une intégration de la vague', () => {
    expect(lead).toMatch(/never launch a `livreur` while the wave integrates a lot \(`cadence lead tour` shows it\)/i)
  })

  it('R12 — skills/lead/SKILL.md ne dit plus que la livraison est jamais faite par un sous-agent', () => {
    expect(lead).not.toContain('never by a subagent, never two deliveries in parallel')
    expect(lead).not.toContain("is always recorded by the lead's own `raf ux`, never by a subagent")
    expect(lead).toMatch(/`raf review` stays with the lead/)
    expect(lead).toMatch(/the delivery and, with `lead\.ux: lead`, `raf ux` may be done by the `livreur`/)
  })

  it('le brief du livreur et le lien docs : docs/lead.md, docs/skills.md, README et CHANGELOG le nomment', () => {
    for (const f of ['docs/lead.md', 'docs/skills.md', 'CHANGELOG.md']) {
      expect(readFileSync(join(root, f), 'utf8'), f).toContain('livreur')
    }
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toMatch(/livreur/)
  })
})
