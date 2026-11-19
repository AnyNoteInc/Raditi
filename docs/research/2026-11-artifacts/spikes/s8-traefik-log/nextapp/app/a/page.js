// The fallback address /a?k=…: the page reads the key from the query, as Э10 would.
export const dynamic = 'force-dynamic'

export default async function Share({ searchParams }) {
  const { k } = await searchParams
  return <p>key of {String(k ?? '').length} characters</p>
}
