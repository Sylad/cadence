import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L258 : le skill lead et docs/lead.md disent quoi faire d'un titre périmé (--goal, goal:) au lieu de déléguer à la main.
const root = join(import.meta.dirname, '..')
const skill = readFileSync(join(root, 'skills/lead/SKILL.md'), 'utf8')
const doc = readFileSync(join(root, 'docs/lead.md'), 'utf8')
const delegation = skill.slice(skill.indexOf('## 2. Delegation'), skill.indexOf('### 2b.'))

describe('skills/lead/SKILL.md et docs/lead.md — objectif d\'un titre périmé (L258)', () => {
  it('R1 — le skill, à la délégation, renvoie un titre périmé vers --goal et la clé goal: avant toute délégation à la main', () => {
    expect(delegation).toContain('--goal')
    expect(delegation).toContain('goal:')
    expect(delegation).toMatch(/stale/i)
  })

  it('R2 — la commande de la vague (2b) propose --goal', () => {
    const wave = skill.slice(skill.indexOf('### 2b.'), skill.indexOf('### 2c.'))
    expect(wave).toContain('--goal')
  })

  it('R3 — docs/lead.md décrit --goal et la clé goal:', () => {
    expect(doc).toContain('--goal')
    expect(doc).toContain('`goal:`')
  })
})
