'use client'

import Button from '@mui/material/Button'
import { artifactRoleAtLeast } from '@repo/domain/artifacts'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { ArtifactPage } from './artifact-page'
import { galleryTexts } from './artifact-texts'

/**
 * The page of an artifact with what its owner does from its head (Ар23): «В корзину» now; the
 * history (88.11а) and «Опубликовать как страницу» (88.11б) stand beside it.
 */
export function ArtifactView({ artifactId }: { artifactId: string }) {
  const trpc = useTRPC()
  const router = useRouter()
  const trash = useMutation(trpc.artifact.trash.mutationOptions())
  return (
    <ArtifactPage
      artifactId={artifactId}
      actions={(artifact) =>
        artifactRoleAtLeast(artifact.role, 'owner') ? (
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
        ) : null
      }
    />
  )
}
