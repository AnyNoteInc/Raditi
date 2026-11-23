'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { artifactRoleLabels } from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useTRPC } from '@/trpc/client'

import { ArtifactKindIcon } from './artifact-kind-icon'

export const inviteTexts = Object.freeze({
  title: 'Приглашения',
  line: (name: string, title: string, role: string) =>
    `${name || 'Пользователь Радити'} открыл(а) вам «${title}» · ${role}`,
  consent: 'Ваше имя увидят владелец и все, у кого есть доступ; почту — владелец.',
  accept: 'Открыть',
  decline: 'Отклонить',
  failed: 'Приглашение больше не действует.',
})

/**
 * «Приглашения» of the gallery (docs/plan/88-artifacts.md, Ар35; board E-invitee): those to the
 * user's confirmed address, with the words of consent before «Открыть».
 */
export function ArtifactInvites() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const invites = useQuery(trpc.artifact.myInvites.queryOptions())
  const accept = useMutation(trpc.artifact.inviteAccept.mutationOptions())
  const decline = useMutation(trpc.artifact.inviteDecline.mutationOptions())
  const [failed, setFailed] = useState(false)
  const rows = invites.data ?? []
  if (rows.length === 0) return null
  const reread = () =>
    queryClient.invalidateQueries({ queryKey: trpc.artifact.myInvites.queryKey() })
  return (
    <Box
      component="section"
      aria-label={inviteTexts.title}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, display: 'grid', gap: 1 }}
    >
      <Typography component="h2" variant="subtitle1">
        {inviteTexts.title}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {inviteTexts.consent}
      </Typography>
      {rows.map((invite) => (
        <Box
          key={invite.inviteId}
          sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
            <ArtifactKindIcon kind={invite.kind} size={16} />
          </Box>
          <Typography variant="body2" sx={{ flex: '1 1 240px', minWidth: 0 }}>
            {inviteTexts.line(invite.ownerName, invite.title, artifactRoleLabels[invite.role])}
          </Typography>
          <Button
            size="small"
            variant="contained"
            disabled={accept.isPending}
            onClick={() => {
              setFailed(false)
              void accept
                .mutateAsync({ inviteId: invite.inviteId })
                .then(({ artifactId }) => router.push(`/artifacts/${artifactId}`))
                .catch(() => {
                  setFailed(true)
                  void reread()
                })
            }}
          >
            {inviteTexts.accept}
          </Button>
          <Button
            size="small"
            color="inherit"
            disabled={decline.isPending}
            onClick={() =>
              void decline.mutateAsync({ inviteId: invite.inviteId }).finally(() => void reread())
            }
          >
            {inviteTexts.decline}
          </Button>
        </Box>
      ))}
      {failed && <Alert severity="warning">{inviteTexts.failed}</Alert>}
    </Box>
  )
}
