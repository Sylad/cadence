import type { ClientElements, ThemeKey } from 'claude-code'

import type { PanelLot } from './lots'
import { subsText } from './lots'

/** Ce que la région de réordonnancement inscrit dans la première colonne de retrait d'une ligne : un glyphe et sa couleur. */
export type RowMark = { glyph: string; color: ThemeKey }

export type RowOptions = {
  /** Remplace la première colonne du retrait par un repère (la bascule ▸/▾ d'un lot à sous-lots, L411, garde sa cellule). */
  mark?: RowMark
  /** Souligne la ligne. */
  emphasis?: 'selected' | 'target'
  /** Sur une surface sans région Client (mobile, éditeur) : la bascule des sous-lots est un Button (clé `subs.key`) qui appelle ceci. Dans la région, c'est le pointeur sur la cellule ▸/▾ ou Entrée. */
  onToggle?: () => void
}

/** Une ligne de lot du panneau : retrait, id, titre avec son compte de sous-lots et ses `after:`, état. */
export const lotRow = ({ Box, Text, Button }: Pick<ClientElements, 'Box' | 'Text' | 'Button'>, line: PanelLot, key: string, options: RowOptions = {}) => {
  const { mark, emphasis, onToggle } = options
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
  // les deux premières colonnes du retrait : le repère prend la première ; la seconde porte la bascule d'un lot du premier niveau à sous-lots (« ␣▸L401 »), sinon rien
  const head = mark ? (
    <Text color={mark.color}>
      {mark.glyph}
      <Text dimColor>{line.lead.slice(1, 2)}</Text>
    </Text>
  ) : (
    <Text dimColor>{line.lead.slice(0, 2)}</Text>
  )
  return (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row">
        <Box width={line.idWidth} flexShrink={0}>
          {line.subs && onToggle ? (
            <Button key={line.subs.key} plain onPress={onToggle}>
              {`${line.lead}${line.id}`}
            </Button>
          ) : (
            <Text wrap="truncate-end" bold={emphasis === 'selected'} underline={emphasis === 'target'}>
              {head}
              <Text dimColor>{line.lead.slice(2)}</Text>
              {line.id}
            </Text>
          )}
        </Box>
        <Box paddingLeft={2} flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            {line.title}
            {line.subs && <Text dimColor>{`  ${subsText(line.subs.count)}`}</Text>}
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
