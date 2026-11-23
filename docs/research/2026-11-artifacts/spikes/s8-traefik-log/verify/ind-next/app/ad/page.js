import Share from '../_share/share'
// The same share page, rendered on demand (no-store, as the real /a would be).
export const dynamic = 'force-dynamic'
export default async function ShareDynamic({ searchParams }) { await searchParams; return <Share /> }
