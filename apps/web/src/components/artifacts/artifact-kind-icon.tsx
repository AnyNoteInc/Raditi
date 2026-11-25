import type { ArtifactKind } from '@repo/domain/artifacts'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

/** The icon of each kind of artifact: in the gallery, in «Создать», on a tab beside the chat. */
export const artifactKindIcons: Readonly<Record<ArtifactKind, AppIconName>> = Object.freeze({
  document: 'document',
  canvas: 'canvas',
  slides: 'slides',
  image: 'image',
})

/** The icon of a kind read back from a row: a kind that left the list is a document. */
export const artifactKindIcon = (kind: string): AppIconName =>
  (artifactKindIcons as Record<string, AppIconName>)[kind] ?? 'document'

export function ArtifactKindIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  return <AppIcon name={artifactKindIcon(kind)} size={size} />
}
