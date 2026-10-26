'use client'

import { usePathname } from 'next/navigation'

import { DialogNotFound } from '@/components/chat/dialog-not-found'

/**
 * A dialog the server does not find for this site (`loadDialog` calls `notFound`): the site is
 * there — its shell is drawn — so the page says the dialog is gone, not the project.
 */
export default function NotFound() {
  const pathname = usePathname()
  // The address of the dialog without its id: the list of the site's dialogs.
  return <DialogNotFound listHref={pathname.slice(0, pathname.lastIndexOf('/'))} />
}
