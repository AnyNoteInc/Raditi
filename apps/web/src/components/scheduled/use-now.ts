'use client'

import { useEffect, useState } from 'react'

/** The time now, again every half a minute: «Следующий запуск» and «сегодня» stay right. */
export function useNow(every = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), every)
    return () => window.clearInterval(timer)
  }, [every])
  return now
}
