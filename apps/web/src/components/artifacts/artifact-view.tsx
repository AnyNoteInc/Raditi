'use client'

import Button from '@mui/material/Button'
import { artifactRoleAtLeast } from '@repo/domain/artifacts'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'

import { AppIcon } from '@/components/application/app-icon'
import { DictationAvailable } from '@/components/chat/dictation-button'
import { useTRPC } from '@/trpc/client'

import { ArtifactHistoryButton } from './artifact-history'
import { ArtifactMoveButton } from './artifact-move'
import { ArtifactLeaveButton, ArtifactShareButton } from './artifact-share'
import { ArtifactPublishButton } from './artifact-publish'
import { ArtifactPage } from './artifact-page'
import { galleryTexts } from './artifact-texts'

/**
 * The page of an artifact with what its owner does from its head (Ар23): «В корзину» now; the
 * history (88.11а) and «Опубликовать как страницу» (88.11б) stand beside it.
 */
export function ArtifactView({
  artifactId,
  speech = false,
  sharing = false,
}: {
  artifactId: string
  /** Dictation into the fields of notes (SpeechKit, docs/plan/75, ВВ16). */
  speech?: boolean
  /** Access of other users is open here (docs/plan/88-artifacts.md, 88.16; the flag of production). */
  sharing?: boolean
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const trash = useMutation(trpc.artifact.trash.mutationOptions())
  return (
    <DictationAvailable.Provider value={speech}>
      <ArtifactPage
        artifactId={artifactId}
        actions={(artifact, reread) => (
          <>
            <ArtifactHistoryButton artifact={artifact} onChanged={reread} />
            <ArtifactPublishButton artifact={artifact} />
            <ArtifactMoveButton artifact={artifact} onChanged={reread} />
            {sharing ? <ArtifactShareButton artifact={artifact} /> : null}
            {sharing ? <ArtifactLeaveButton artifact={artifact} /> : null}
            {artifactRoleAtLeast(artifact.role, 'owner') ? (
              <Button
                variant="text"
                color="inherit"
                startIcon={<AppIcon name="trash" size={16} />}
                onClick={() =>
                  void trash.mutateAsync({ artifactId }).then(() => router.push('/artifacts'))
                }
              >
                {galleryTexts.toTrash}
              </Button>
            ) : null}
          </>
        )}
      />
    </DictationAvailable.Provider>
  )
}
