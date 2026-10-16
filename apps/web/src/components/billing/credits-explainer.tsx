'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

import { nbsp } from '@/lib/nbsp'

import type { CreditConversion } from './billing-types'
import {
  creditDefinition,
  creditPromises,
  DAY_RULE,
  exactCalculation,
  ORIENTATION_HEADINGS,
  orientationList,
  REVISION_RULE,
} from './credits-examples'

/** The summary of a collapsed block: a row as tall as a finger needs, with its own marker. */
const summary = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  minHeight: 44,
  cursor: 'pointer',
  fontSize: 15,
  fontWeight: 500,
  lineHeight: 1.4,
  listStyle: 'none',
  '&::-webkit-details-marker': { display: 'none' },
  '&::before': {
    content: '"+"',
    display: 'inline-block',
    width: '1ch',
    color: 'text.secondary',
    fontWeight: 400,
  },
  'details[open] > &::before': { content: '"−"' },
  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
} as const

const paragraph = { maxWidth: '68ch', lineHeight: 1.55 } as const

const cell = {
  py: 1,
  pr: 2,
  borderBottom: 1,
  borderColor: 'divider',
  textAlign: 'left',
  verticalAlign: 'top',
  '&:last-child': { pr: 0 },
} as const

function Paragraph({ children, mt = 1.5 }: { children: ReactNode; mt?: number }) {
  return (
    <Typography variant="body2" sx={{ ...paragraph, mt }}>
      {children}
    </Typography>
  )
}

/** A table that is wider than a phone scrolls inside its own frame, which the keyboard reaches. */
function Scrollable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box
      role="group"
      aria-label={label}
      tabIndex={0}
      sx={{
        mt: 1.5,
        overflowX: 'auto',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 3 },
      }}
    >
      {children}
    </Box>
  )
}

/**
 * «Как считаются кредиты», collapsed under the tariffs: what a credit is, what a request
 * usually costs, what the customer is promised, what the daily limit counts and how often the
 * calculation may change — and, one level deeper, «Точный расчёт»: the conversion the charge is
 * counted by. `conversion` is the table the server sends; without one — no credit rate is
 * usable — «Точный расчёт» is not shown at all.
 */
export function CreditsExplainer({ conversion }: { conversion: CreditConversion | null }) {
  const exact = exactCalculation(conversion)
  return (
    <Box component="details" sx={{ mt: 2 }}>
      <Box component="summary" sx={summary}>
        Как считаются кредиты
      </Box>
      <Box sx={{ pb: 1 }}>
        <Paragraph mt={0.5}>{nbsp(creditDefinition())}</Paragraph>

        <Scrollable label="Сколько обычно стоит задача">
          <Box
            component="table"
            sx={{ width: '100%', maxWidth: '68ch', borderCollapse: 'collapse', fontSize: 14 }}
          >
            <thead>
              <tr>
                <Box
                  component="th"
                  scope="col"
                  sx={{ ...cell, color: 'text.secondary', fontWeight: 500 }}
                >
                  {ORIENTATION_HEADINGS.request}
                </Box>
                <Box
                  component="th"
                  scope="col"
                  sx={{ ...cell, color: 'text.secondary', fontWeight: 500 }}
                >
                  {ORIENTATION_HEADINGS.cost}
                </Box>
              </tr>
            </thead>
            <tbody>
              {orientationList().map(({ request, cost }) => (
                <tr key={request}>
                  <Box component="td" sx={cell}>
                    {nbsp(request)}
                  </Box>
                  <Box component="td" sx={{ ...cell, whiteSpace: 'nowrap' }}>
                    {nbsp(cost)}
                  </Box>
                </tr>
              ))}
            </tbody>
          </Box>
        </Scrollable>

        <Box component="ul" sx={{ ...paragraph, m: 0, mt: 2, pl: 2.5, fontSize: 14 }}>
          {creditPromises().map((promise) => (
            <Box component="li" key={promise} sx={{ mt: 0.5 }}>
              {nbsp(promise)}
            </Box>
          ))}
        </Box>

        <Paragraph>{nbsp(DAY_RULE)}</Paragraph>
        <Paragraph>{nbsp(REVISION_RULE)}</Paragraph>

        {exact ? (
          <Box component="details" sx={{ mt: 1.5 }}>
            <Box component="summary" sx={summary}>
              Точный расчёт
            </Box>
            <Paragraph mt={0.5}>{nbsp(exact.text)}</Paragraph>
            {exact.table ? (
              <Scrollable label={exact.table.label}>
                <Box
                  component="table"
                  sx={{ width: '100%', maxWidth: '68ch', borderCollapse: 'collapse', fontSize: 14 }}
                >
                  <thead>
                    <tr>
                      <Box
                        component="th"
                        scope="col"
                        sx={{ ...cell, color: 'text.secondary', fontWeight: 500 }}
                      >
                        Модель
                      </Box>
                      {exact.table.columns.map((column) => (
                        <Box
                          component="th"
                          scope="col"
                          key={column}
                          sx={{ ...cell, color: 'text.secondary', fontWeight: 500 }}
                        >
                          {nbsp(column)}
                        </Box>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {exact.table.rows.map(({ model, cells }, index) => (
                      // Two models may carry one name: the row is told by its place.
                      <tr key={`${model}-${index}`}>
                        <Box component="th" scope="row" sx={{ ...cell, fontWeight: 400 }}>
                          {model}
                        </Box>
                        {cells.map((value, column) => (
                          <Box
                            component="td"
                            key={exact.table?.columns[column] ?? column}
                            sx={{
                              ...cell,
                              fontVariantNumeric: 'tabular-nums',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {nbsp(value)}
                          </Box>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Box>
              </Scrollable>
            ) : null}
            <Paragraph>{nbsp(exact.rounding)}</Paragraph>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}
