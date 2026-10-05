import { BrandSymbol } from '@repo/ui/brand-symbol'
import { ImageResponse } from 'next/og'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

/** Generated at build time so the favicon follows the same palette as the interface. */
export default function Icon() {
  return new ImageResponse(<BrandSymbol size={size.width} />, size)
}
