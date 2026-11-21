import type { ArtifactPresence, CabinetArtifact } from './use-artifact'

/**
 * What the body of an artifact gets on its page and in its tab (§7.7): its own file, so that the
 * views of the kinds import it without importing the dispatcher that imports them.
 */
export interface ArtifactBodyProps {
  artifact: CabinetArtifact
  presence: ArtifactPresence | null
  onChanged: () => void
  /** The block the person is in, for their mark of presence. */
  onEditing?: (block: string | null) => void
  /** `page` — `/artifacts/<id>`, wide; `pane` — the tab beside the chat. */
  place: 'page' | 'pane'
}
