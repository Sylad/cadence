import { test as testDuKit } from 'claude-code/testing'
import type { TestRest } from 'claude-code/testing'

/**
 * Le délai au mur d'un test du mod. Le kit en donne 5 s ; ces tests tournent sur une horloge simulée (`mock.clock`), le délai ne
 * borne donc que le temps machine. Sous la charge d'une porte complète (charge ~50 sur 32 cœurs le 17-11), des dizaines de tests de
 * 0,5 à 3 s seuls franchissaient les 5 s, un autre à chaque passage (L717 dans la porte, L719 seul) : porte rouge sans défaut (L769).
 * Un test qui se bloque échoue toujours, au bout de ce délai.
 */
export const DELAI_TEST_MS = 30_000

/** `test` du kit, avec le délai du mod quand le test n'en donne pas. */
export const test = (name: string, ...rest: TestRest): void => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest
  testDuKit(name, { timeoutMs: DELAI_TEST_MS, ...options }, body)
}
