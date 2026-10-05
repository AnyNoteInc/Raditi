// The rules of a user's name. Only zod here, nothing of the server: the profile form of the web
// app imports this file into the browser (`@repo/auth/profile-schema`) and checks a name with the
// very schema the server applies.
import { z } from 'zod'

// PostgreSQL refuses U+0000 in text; the other control characters break a one-line name.
export const NO_CONTROL_CHARACTERS = /^\P{Cc}*$/u

/** The name a user is addressed by, for every path that writes `users.name` (VarChar 255). */
export const profileNameSchema = z.string().trim().min(1).max(255).regex(NO_CONTROL_CHARACTERS)

/** The optional surname (`users.last_name`); a blank value removes it. */
export const profileLastNameSchema = z
  .string()
  .trim()
  .max(255)
  .regex(NO_CONTROL_CHARACTERS)
  .transform((value) => value || null)
