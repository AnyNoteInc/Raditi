import { redirect } from 'next/navigation'

/** Keep existing sign-in links pointing to the new project home. */
export default function CabinetPage() {
  redirect('/projects')
}
