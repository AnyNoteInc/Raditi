'use client'

import { brandColors } from '@repo/ui/theme/tokens'
import { useEffect } from 'react'

// Replaces the root layout: use palette tokens directly without depending on its provider.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: brandColors.paper,
          color: brandColors.ink,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <main style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: 28, margin: '0 0 12px' }}>Сервис временно недоступен</h1>
          <p style={{ color: brandColors.graphite, margin: '0 0 24px', lineHeight: 1.6 }}>
            Мы уже разбираемся. Обновите страницу через пару минут.
            {error.digest ? ` Код ошибки для поддержки: ${error.digest}.` : ''}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '12px 22px',
              border: 0,
              borderRadius: 999,
              background: brandColors.accent,
              color: brandColors.ink,
              font: 'inherit',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Попробовать ещё раз
          </button>
        </main>
      </body>
    </html>
  )
}
