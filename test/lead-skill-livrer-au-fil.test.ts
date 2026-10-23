import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L277 : le skill lead et la documentation disent de livrer au fil de l'eau un lot prêt, au lieu d'attendre la fin de la vague.
const root = join(import.meta.dirname, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const skill = read('skills/lead/SKILL.md')
const wave = skill.slice(skill.indexOf('### 2b.'), skill.indexOf('### 2c.'))

describe('livrer au fil de l\'eau — skill lead et documentation (L277)', () => {
  it('R8 — le skill lead, au suivi de la vague (2b), dit de livrer un lot prêt sans attendre la fin de la vague, par son sha « livrable jusqu\'à »', () => {
    expect(wave).toContain('cadence deliver --sha')
    expect(wave).toMatch(/without waiting for the end of the wave/)
  })

  it('R8 — le skill dit que le sha se pousse seul, jamais HEAD, et que cadence deliver sans --sha reste refusé pendant la vague', () => {
    expect(wave).toMatch(/never HEAD/)
    expect(wave).toMatch(/Without `--sha`.*refused/s)
  })

  it('R9 — docs/deliver.md, docs/orchestrate.md et docs/lead.md décrivent la livraison pendant une vague', () => {
    for (const f of ['docs/deliver.md', 'docs/orchestrate.md', 'docs/lead.md']) expect(read(f), f).toMatch(/while (the|a) wave (is )?runs?/)
  })

  it('R9 — le README mentionne la livraison pendant la vague', () => {
    expect(read('README.md')).toMatch(/while (the|a) wave (is )?runs?/)
  })
})
