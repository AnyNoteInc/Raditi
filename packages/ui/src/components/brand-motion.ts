export const BRAND_MOTION_VARIANTS = ['spiral', 'counterflow', 'orbits', 'rosette'] as const

export type BrandMotionVariant = (typeof BRAND_MOTION_VARIANTS)[number]

export const BRAND_MOTION_DURATION_MS = 4200

export type BrandMotionRay = {
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
  opacity: number
}

const TAU = Math.PI * 2
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const smooth = (value: number) => {
  const x = clamp(value)
  return x * x * (3 - 2 * x)
}
const ramp = (progress: number, start: number, end: number) =>
  smooth((progress - start) / (end - start))

/** A new visit can use any variant except the previous visit's choice. */
export function pickBrandMotion(
  previous: string | null,
  random: () => number = Math.random,
): BrandMotionVariant {
  const available = BRAND_MOTION_VARIANTS.filter((variant) => variant !== previous)
  return (
    available[Math.floor(random() * available.length)] ?? available[0] ?? BRAND_MOTION_VARIANTS[0]
  )
}

/** The four approved trajectories, in the mark's 60-unit coordinate system around its centre. */
export function getBrandMotionPose(
  variant: BrandMotionVariant,
  progress: number,
): BrandMotionRay[] {
  const t = clamp(progress)
  const rays: { ray: BrandMotionRay; depth: number }[] = []

  for (let i = 0; i < 6; i++) {
    const base = -Math.PI / 2 + (i * TAU) / 6
    let x: number
    let y: number
    let direction: number
    let half: number
    let width = 8.3
    let opacity = 1
    let depth = 0

    if (variant === 'spiral') {
      const spread = ramp(t, 0.07, 0.23) * (1 - ramp(t, 0.27, 0.77))
      const turn = 1.5 * TAU * ramp(t, 0.12, 0.8)
      const angle = base + turn
      const radius = 6.25 + 16.75 * spread
      x = Math.cos(angle) * radius
      y = Math.sin(angle) * radius
      direction = angle + (Math.PI / 2) * spread
      half = 6.25 - 2.8 * spread
    } else if (variant === 'counterflow') {
      const pair = i % 3
      const spread = ramp(t, 0.07, 0.23) * (1 - ramp(t, 0.52 + pair * 0.04, 0.73 + pair * 0.04))
      const sign = i % 2 === 0 ? 1 : -1
      const angle = base + sign * TAU * ramp(t, 0.13, 0.76)
      const radius = 6.25 + (i % 2 === 0 ? 16.25 : 9.25) * spread
      x = Math.cos(angle) * radius
      y = Math.sin(angle) * radius
      direction = angle + sign * (Math.PI / 2) * spread
      half = 6.25 - 2.8 * spread
    } else if (variant === 'orbits') {
      const spread = ramp(t, 0.07, 0.23) * (1 - ramp(t, 0.57, 0.8))
      const pair = i % 3
      const axis = -Math.PI / 2 + (pair * TAU) / 6
      const phase =
        TAU * ramp(t, 0.12, 0.78) + ((pair * Math.PI) / 3) * spread + (i >= 3 ? Math.PI : 0)
      const major = 6.25 + 15.25 * spread
      const minor = 8.5 * spread
      const u = Math.cos(phase) * major
      const v = Math.sin(phase) * minor
      x = Math.cos(axis) * u - Math.sin(axis) * v
      y = Math.sin(axis) * u + Math.cos(axis) * v
      depth = Math.sin(phase) * spread
      const scale = 1 + 0.13 * depth
      direction = axis + phase + (Math.PI / 2) * spread
      half = (6.25 - 3 * spread) * scale
      width = 8.3 * scale
      opacity = 1 - 0.34 * Math.max(0, -depth)
    } else {
      const q = ramp(t, 0.08, 0.8)
      const phase = TAU * q + 0.25 * Math.sin(Math.PI * q) * Math.sin((i * TAU) / 6)
      const spread = Math.sin(Math.PI * q) ** 2
      const radial = 6.25 + 7.5 * (1 - Math.cos(phase))
      const tangent = 9.5 * Math.sin(phase)
      x = Math.cos(base) * radial - Math.sin(base) * tangent
      y = Math.sin(base) * radial + Math.cos(base) * tangent
      direction = base + phase
      half = 6.25 - 3 * spread
    }

    const dx = Math.cos(direction) * half
    const dy = Math.sin(direction) * half
    rays.push({
      ray: { x1: x - dx, y1: y - dy, x2: x + dx, y2: y + dy, width, opacity },
      depth,
    })
  }

  // Paint rear rays first when the projected orbits cross.
  return rays.sort((a, b) => a.depth - b.depth).map(({ ray }) => ray)
}
