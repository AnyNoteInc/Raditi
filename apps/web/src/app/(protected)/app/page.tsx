import { redirect } from 'next/navigation'

/** Keep existing sign-in links pointing to the first page of the cabinet. */
export default function CabinetPage() {
  redirect('/chats')
}
