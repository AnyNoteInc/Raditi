import Avatar from '@mui/material/Avatar'

export type ApplicationUser = {
  name: string
  lastName?: string | null
  email: string
  image?: string | null
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/**
 * The address the avatar upload writes to `users.image`, or the local preview of a chosen photo
 * (a blob: URL exists only in the page that made it). Anything else, such as an external
 * address written before the upload became the only path, is never fetched by the browser.
 */
const SHOWN_IMAGE = new RegExp(`^(?:/api/profile/avatar/${UUID}/${UUID}\\.webp$|blob:)`)

export function applicationUserName(user: ApplicationUser): string {
  const name = user.name.trim().replace(/\s+/g, ' ')
  const lastName = user.lastName?.trim().replace(/\s+/g, ' ') || ''
  if (!lastName) return name
  if (!name) return lastName
  const normalizedName = name.toLocaleLowerCase('ru')
  const normalizedLastName = lastName.toLocaleLowerCase('ru')
  return normalizedName === normalizedLastName || normalizedName.endsWith(` ${normalizedLastName}`)
    ? name
    : `${name} ${lastName}`
}

export function UserAvatar({ user, size = 32 }: { user: ApplicationUser; size?: number }) {
  const name = applicationUserName(user)
  const parts = user.lastName?.trim() ? [user.name.trim(), user.lastName.trim()] : name.split(/\s+/)
  const initials = (
    parts
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('') || user.email.slice(0, 1)
  ).toLocaleUpperCase('ru')
  return (
    <Avatar
      src={user.image && SHOWN_IMAGE.test(user.image) ? user.image : undefined}
      alt={name || user.email}
      sx={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        fontWeight: 600,
        bgcolor: 'primary.main',
        color: 'primary.contrastText',
      }}
    >
      {initials}
    </Avatar>
  )
}
