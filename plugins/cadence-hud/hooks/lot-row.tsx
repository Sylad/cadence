import type { ClientElements, ThemeKey } from 'claude-code'

import type { PanelLot } from './lots'

/** Ce que la région de réordonnancement inscrit dans les deux colonnes de retrait d'une ligne : un glyphe et sa couleur. */
export type RowMark = { glyph: string; color: ThemeKey }

/** Une ligne de lot du panneau : retrait, id, titre avec ses `after:`, état. `mark` remplace le retrait de premier niveau (deux colonnes) par un repère ; `emphasis` souligne la ligne. */
export const lotRow = ({ Box, Text }: Pick<ClientElements, 'Box' | 'Text'>, line: PanelLot, key: string, mark?: RowMark, emphasis?: 'selected' | 'target') => {
  const after = line.after.length > 0 && (
    <Text color="subtle">
      after:{' '}
      {line.after.map((a, j) => (
        <Text key={a.id} strikethrough={a.struck}>
          {j > 0 ? ' ' : ''}
          {a.id}
        </Text>
      ))}
    </Text>
  )
  return (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row">
        <Box width={line.idWidth} flexShrink={0}>
          <Text wrap="truncate-end" bold={emphasis === 'selected'} underline={emphasis === 'target'}>
            {mark ? <Text color={mark.color}>{mark.glyph} </Text> : <Text dimColor>{line.lead.slice(0, 2)}</Text>}
            <Text dimColor>{line.lead.slice(2)}</Text>
            {line.id}
          </Text>
        </Box>
        <Box paddingLeft={2} flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            {line.title}
            {!line.afterOwnLine && after && '  '}
            {!line.afterOwnLine && after}
          </Text>
        </Box>
        <Box paddingLeft={2} width={line.stateWidth + 2} flexShrink={0}>
          <Text wrap="truncate-end" color={line.state.color}>
            {line.state.text}
          </Text>
        </Box>
      </Box>
      {line.afterOwnLine && (
        <Box paddingLeft={line.idWidth}>
          <Text wrap="truncate-end">{after}</Text>
        </Box>
      )}
    </Box>
  )
}
