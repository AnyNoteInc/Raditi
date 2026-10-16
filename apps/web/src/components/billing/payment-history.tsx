'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'

import { AppIcon } from '@/components/application/app-icon'
import { nbsp } from '@/lib/nbsp'
import { formatRubles } from '@/lib/rubles'

import { PaymentTile, sectionHeading, sectionPadding } from './billing-surface'
import type { PaymentEntry } from './billing-types'
import { paidFor, paymentDate, paymentStatus } from './payment-format'

const PLANS_PATH = '/settings/plans'

const cell = { py: 1.75, pr: 2, borderBottom: 1, borderColor: 'divider', verticalAlign: 'top' }
const lastCell = { '&:last-child': { pr: 0 } }
const amountCell = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const noteLine = { display: 'block', color: 'text.secondary' }
// The sentence under a status wraps early: left to its full length, it would take the width
// of the table from the column that says what was paid for.
const statusNote = { ...noteLine, maxWidth: '40ch', mt: 0.5 }

function Status({ payment }: { payment: PaymentEntry }) {
  const status = paymentStatus(payment)
  return (
    <>
      <Chip
        size="small"
        variant="outlined"
        color={status.color}
        icon={<AppIcon name={status.icon} size={14} />}
        label={status.label}
        sx={{
          height: 'auto',
          minHeight: 26,
          fontSize: 12,
          borderColor: 'currentColor',
          ...(status.color === 'default' ? { color: 'text.secondary' } : {}),
          '& .MuiChip-icon': { ml: 1, color: 'inherit' },
        }}
      />
      {status.note ? (
        <Box component="span" sx={statusNote}>
          {nbsp(status.note)}
        </Box>
      ) : null}
    </>
  )
}

function PaymentRow({ payment }: { payment: PaymentEntry }) {
  const what = paidFor(payment)
  return (
    <tr>
      <Box component="td" sx={{ ...cell, whiteSpace: 'nowrap' }}>
        {paymentDate(payment)}
      </Box>
      <Box component="td" sx={{ ...cell, overflowWrap: 'anywhere' }}>
        {what.title}
        {what.period ? (
          <Box component="span" sx={{ ...noteLine, whiteSpace: 'nowrap' }}>
            {what.period}
          </Box>
        ) : null}
      </Box>
      <Box component="td" sx={{ ...cell, ...amountCell }}>
        {formatRubles(payment.amount)}&nbsp;₽
      </Box>
      <Box component="td" sx={{ ...cell, ...lastCell }}>
        <Status payment={payment} />
      </Box>
    </tr>
  )
}

/**
 * «История платежей»: the orders of the customer, newest first — what each one paid for, how
 * much and how it ended. «Показать ещё» asks for the next page. A customer who has paid for
 * nothing yet sees where the payments will be and, without a tariff, the way to choose one.
 */
export function PaymentHistory({
  payments,
  hasMore,
  loadingMore,
  moreFailed,
  onMore,
  hasTariff,
}: {
  payments: readonly PaymentEntry[]
  /** There is a page after the ones that are shown. */
  hasMore: boolean
  loadingMore: boolean
  /** The last «Показать ещё» did not bring its page. */
  moreFailed: boolean
  onMore: () => void
  /** The customer has a live tariff: nothing is left to choose. */
  hasTariff: boolean
}) {
  if (payments.length === 0) {
    return (
      <Box component="section" aria-labelledby="history-title" sx={{ p: sectionPadding }}>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px 24px',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              flex: '1 1 320px',
              alignItems: 'flex-start',
              gap: 2,
              minWidth: 0,
            }}
          >
            <PaymentTile />
            <Box sx={{ minWidth: 0 }}>
              <Typography component="h2" id="history-title" sx={sectionHeading}>
                Платежей пока нет
              </Typography>
              <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
                {nbsp('Здесь появятся платежи за тариф и пакеты кредитов.')}
              </Typography>
            </Box>
          </Box>
          {hasTariff ? null : (
            <Button variant="contained" href={PLANS_PATH}>
              Выбрать тариф
            </Button>
          )}
        </Box>
      </Box>
    )
  }

  return (
    <Box component="section" aria-labelledby="history-title" sx={{ p: sectionPadding }}>
      <Typography component="h2" id="history-title" sx={sectionHeading}>
        История платежей
      </Typography>
      <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
        {nbsp('Платежи за тариф и пакеты кредитов.')}
      </Typography>
      {/* A table wider than a phone scrolls inside its own frame, which the keyboard reaches. */}
      <Box
        role="group"
        aria-labelledby="history-title"
        tabIndex={0}
        sx={{
          mt: 2.5,
          overflowX: 'auto',
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 3,
          },
        }}
      >
        <Box
          component="table"
          aria-labelledby="history-title"
          sx={{
            width: '100%',
            minWidth: 600,
            borderCollapse: 'collapse',
            fontSize: 14,
            lineHeight: 1.45,
            '& th': {
              py: 1.25,
              pr: 2,
              borderBottom: 1,
              borderColor: 'divider',
              color: 'text.secondary',
              fontWeight: 500,
              textAlign: 'left',
              whiteSpace: 'nowrap',
              ...lastCell,
            },
          }}
        >
          <thead>
            <tr>
              <th scope="col">Дата</th>
              <th scope="col">За что</th>
              <Box component="th" scope="col" sx={{ '&&': { textAlign: 'right' } }}>
                Сумма
              </Box>
              <th scope="col">Статус</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => (
              <PaymentRow key={payment.id} payment={payment} />
            ))}
          </tbody>
        </Box>
      </Box>
      {moreFailed ? (
        <Typography role="alert" variant="body2" color="error" sx={{ mt: 2.5 }}>
          {nbsp('Не удалось загрузить продолжение истории. Попробуйте ещё раз.')}
        </Typography>
      ) : null}
      {hasMore ? (
        <Box sx={{ mt: 2.5 }}>
          <Button variant="outlined" loading={loadingMore} onClick={onMore}>
            Показать ещё
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}
