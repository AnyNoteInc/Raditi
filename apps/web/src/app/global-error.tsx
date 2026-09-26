'use client'

import { useEffect } from 'react'

// Replaces the root layout, so no theme or MUI here: plain HTML with inline styles.
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
          background: '#F4F5F1',
          color: '#15171A',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <main style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: 28, margin: '0 0 12px' }}>Сервис временно недоступен</h1>
          <p style={{ color: '#565C66', margin: '0 0 24px', lineHeight: 1.6 }}>
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
              background: '#2A36D6',
              color: '#FFFFFF',
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
