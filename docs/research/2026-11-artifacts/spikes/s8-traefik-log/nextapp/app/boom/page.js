// A page that fails on the server: what does Next print?
export const dynamic = 'force-dynamic'

export default async function Boom({ searchParams }) {
  await searchParams
  throw new Error('spike: the page failed')
}
