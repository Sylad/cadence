import type { ClientModule } from 'claude-code'

// ── L449 : l'ordre des projets dans le panneau, réordonnable à la souris (glisser-déposer) et au clavier (Alt+↑ / Alt+↓) ──
// Région Client : elle ne connaît que ses lignes (un nom, un détail) ; le dépôt est posté au module de hooks, qui contrôle la demande et lance cadence.

type Props = { projects: { name: string; detail: string }[] }
/** Le glisser retient le projet saisi par son nom, pas par sa ligne : les props changent pendant un geste (relecture du tableau). */
type State = { selected?: string; drag?: { name: string; over: number } }

/** L'état le plus récent de chaque instance : `surface.state` ne change qu'à l'image suivante, or un geste rapide peut en enchaîner deux dans la même. */
const live = new WeakMap<object, State>()

const List: ClientModule<Props, State> = (props, surface) => {
  const { projects } = props
  const current = (): State => live.get(surface) ?? surface.state ?? {}
  const keep = (next: State) => {
    live.set(surface, next)
    surface.setState(next)
  }
  const at = (name: string | undefined) => projects.findIndex(p => p.name === name)
  const rowAt = (y: number) => Math.min(projects.length - 1, Math.max(0, y))
  const ask = (from: number, to: number, place: 'before' | 'after') => surface.post({ kind: 'project-move', id: projects[from]!.name, target: projects[to]!.name, place })

  surface.onPointer(e => {
    if (e.button !== 'left') return // un survol n'a pas de bouton
    const { drag, selected } = current()
    if (e.type === 'down') {
      const i = rowAt(e.y)
      keep({ selected: projects[i]!.name, drag: { name: projects[i]!.name, over: i } })
    } else if (e.type === 'move' && drag) {
      keep({ selected, drag: { name: drag.name, over: rowAt(e.y) } })
    } else if (e.type === 'up' && drag) {
      const from = at(drag.name) // retrouvé à l'arrivée : le projet saisi a pu changer de ligne, ou disparaître (rien n'est alors demandé)
      const over = rowAt(e.y)
      keep({ selected })
      if (from >= 0 && over !== from) ask(from, over, over > from ? 'after' : 'before')
    }
  })

  surface.onKey(k => {
    if (k.key !== 'up' && k.key !== 'down') return
    const step = k.key === 'up' ? -1 : 1
    const cur = at(current().selected)
    if (!k.meta) {
      const i = cur < 0 ? (step > 0 ? 0 : projects.length - 1) : Math.min(projects.length - 1, Math.max(0, cur + step))
      keep({ selected: projects[i]!.name })
      return
    }
    const to = cur + step
    if (cur >= 0 && to >= 0 && to < projects.length) ask(cur, to, step < 0 ? 'before' : 'after')
  })

  const state = current()
  const { Box, Text } = surface.elements
  const held = at(state.drag?.name)
  const hover = state.drag?.over ?? -1
  const dragging = held >= 0 && hover !== held // un projet disparu pendant le geste ne laisse aucun repère
  const mark = (i: number): { glyph: string; color: 'claude' } | undefined => {
    if (dragging && i === held) return { glyph: '●', color: 'claude' }
    if (dragging && i === hover) return { glyph: hover > held ? '⇣' : '⇡', color: 'claude' }
    return projects[i]!.name === state.selected ? { glyph: '▸', color: 'claude' } : undefined
  }
  return (
    <Box flexDirection="column" width="100%">
      {projects.map((p, i) => {
        const m = mark(i)
        return (
          <Text key={`p${i}`} wrap="truncate-end" bold={p.name === state.selected} underline={dragging && i === hover}>
            {m ? <Text color={m.color}>{m.glyph}</Text> : <Text> </Text>}
            {` ${p.name}`}
            <Text dimColor>{`  ${p.detail}`}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

export default List
