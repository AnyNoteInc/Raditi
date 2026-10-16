'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { nbsp } from '@/lib/nbsp'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import { pageHeading, surface } from './billing-surface'
import { PaymentHistory } from './payment-history'
import { PaymentMethodSection } from './payment-method-section'
import { useBindingSync } from './use-binding-sync'

/**
 * «Настройки → Оплата»: the payment method the tariff is renewed with and the history of the
 * customer's payments. A card the customer bound without the return page learning of it is
 * settled when this page is opened.
 */
export function BillingView() {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const overview = useQuery(trpc.billing.overview.queryOptions())
  useBindingSync(overview.data)
  // Read anew every time the page is opened, whatever the cache holds: a payment made on
  // another page adds an order here. The pages are asked through the client: the infinite
  // options of tRPC add a `direction` to the input, which the procedure refuses.
  const history = useInfiniteQuery({
    queryKey: ['billing-payments'],
    queryFn: ({ pageParam }) =>
      client.billing.payments.query(pageParam === null ? {} : { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchOnMount: 'always',
  })

  // Data that is on the screen stays there when a refresh in the background fails.
  const failed = (overview.isError && !overview.data) || (history.isError && !history.data)

  function retry() {
    if (overview.isError) void overview.refetch()
    if (history.isError) void history.refetch()
  }

  return (
    <Box>
      <Typography component="h1" sx={pageHeading}>
        Оплата
      </Typography>
      <Typography color="textSecondary" sx={{ mt: 1 }}>
        {nbsp('Способ оплаты и история платежей.')}
      </Typography>

      {failed ? (
        <Alert
          severity="error"
          sx={{ mt: 4 }}
          action={
            <Button
              color="inherit"
              size="small"
              loading={overview.isFetching || history.isFetching}
              onClick={retry}
            >
              Повторить
            </Button>
          }
        >
          Не удалось загрузить данные об оплате. Попробуйте ещё раз.
        </Alert>
      ) : !overview.data || !history.data ? (
        <Box role="status" aria-label="Загрузка оплаты">
          <Skeleton variant="rounded" height={360} sx={{ mt: 4, borderRadius: '14px' }} />
        </Box>
      ) : (
        <Stack divider={<Divider />} sx={{ ...surface, mt: 4 }}>
          <PaymentMethodSection overview={overview.data} />
          <PaymentHistory
            payments={history.data.pages.flatMap(({ items }) => items)}
            hasMore={history.hasNextPage}
            loadingMore={history.isFetchingNextPage}
            moreFailed={history.isFetchNextPageError}
            onMore={() => void history.fetchNextPage()}
            hasTariff={overview.data.subscription !== null}
          />
        </Stack>
      )}
    </Box>
  )
}
