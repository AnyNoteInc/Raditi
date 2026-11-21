import { notFound } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default async function NF({ searchParams }) { await searchParams; notFound() }
