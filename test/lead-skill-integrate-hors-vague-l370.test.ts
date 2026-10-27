import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L370 : le skill lead et docs/lead.md donnent le geste d'un lot rendu (budget, revue non conforme) que le lead corrige hors vague :
// corriger dans le worktree, `raf review` dans le worktree, y commiter le plan, puis `--resume --wave <wave> --integrate` — plus d'intégration à la main.
const root = join(import.meta.dirname, '..')
const skill = readFileSync(join(root, 'skills/lead/SKILL.md'), 'utf8')
const doc = readFileSync(join(root, 'docs/lead.md'), 'utf8')

describe('skills/lead/SKILL.md et docs/lead.md — un lot rendu corrigé puis revu hors vague est intégré par --integrate (L370)', () => {
  it('R4 — le skill ne réduit plus --integrate au lot rendu à l\'étape d\'intégration : il nomme le lot rendu corrigé et revu hors vague', () => {
    const line = skill.split('\n').find((l) => l.includes('--integrate <project:lot>'))!
    expect(line).toBeDefined()
    expect(line).toMatch(/reviewed (outside|off) the wave/)
  })
  it('R4 — le skill, là où il dit « the lot is yours », donne le geste : raf review dans le worktree, plan commité là, puis --integrate', () => {
    const yours = skill.slice(skill.indexOf('the lot is yours'))
    const gesture = yours.slice(0, yours.indexOf('\n\n'))
    expect(gesture).toContain('raf review')
    expect(gesture).toContain('worktree')
    expect(gesture).toContain('--integrate')
    expect(gesture).toMatch(/not .*by hand|never .*by hand|no longer .*by hand/)
  })
  it('R4 — docs/lead.md décrit le même geste', () => {
    expect(doc).toContain('--integrate')
    expect(doc).toMatch(/raf review[^\n]*worktree/)
    expect(doc).toContain('L370')
  })
})
