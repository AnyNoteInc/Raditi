import styles from './pricing.module.css'

/**
 * Stands in the place of the plans while they come from the database. It keeps about the height
 * that the plans take at the width of the window, so what stands below — the questions, the final
 * block — moves little when they arrive. `data-pending` tells the page that the plans are not
 * there yet (landing-anchor.tsx).
 */
export function PricingFallback() {
  return (
    <p className={styles.fallback} role="status" data-pending>
      Загружаем тарифы…
    </p>
  )
}
