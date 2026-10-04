import { brandColors } from '../theme/tokens.ts'

/** The same amber circle and rounded six-ray asterisk on every surface and icon. */
export function BrandSymbol({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 60 60"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', display: 'block' }}
    >
      <circle cx="30" cy="30" r="30" fill={brandColors.marker} />
      <path
        d="M30 17.5v25M19.175 23.75l21.65 12.5M19.175 36.25l21.65-12.5"
        fill="none"
        stroke={brandColors.ink}
        strokeWidth="8.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
