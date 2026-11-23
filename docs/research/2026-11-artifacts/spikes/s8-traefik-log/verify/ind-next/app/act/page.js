import { fail } from './actions'
export const dynamic = 'force-dynamic'
export default async function Act({ searchParams }) {
  await searchParams
  return (<form action={fail}><button id="go" type="submit">go</button></form>)
}
