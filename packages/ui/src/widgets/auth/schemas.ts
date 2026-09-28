import { z } from 'zod'

// better-auth defaults (minPasswordLength, maxPasswordLength).
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

const email = z
  .string()
  .trim()
  .min(1, 'Введите адрес электронной почты')
  .max(254, 'Адрес слишком длинный')
  .pipe(z.email('Проверьте адрес электронной почты: в нём есть ошибка'))

const newPassword = z
  .string()
  .min(1, 'Придумайте пароль')
  .min(PASSWORD_MIN_LENGTH, `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов`)
  .max(PASSWORD_MAX_LENGTH, `Пароль должен быть не длиннее ${PASSWORD_MAX_LENGTH} символов`)

const confirmPassword = z.string().min(1, 'Повторите пароль')

/** A required consent checkbox: the form holds a boolean, the output is always `true`. */
const requiredCheckbox = (message: string) =>
  z
    .boolean()
    .refine((accepted) => accepted, message)
    .transform((): true => true)

const passwordsMatch = (values: { password: string; confirmPassword: string }) =>
  values.password === values.confirmPassword
const PASSWORDS_DIFFER = { path: ['confirmPassword'], error: 'Пароли не совпадают' }

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Введите пароль'),
})

export const registerSchema = z
  .object({
    name: z.string().trim().min(1, 'Введите имя').max(100, 'Имя слишком длинное'),
    email,
    password: newPassword,
    confirmPassword,
    acceptTerms: requiredCheckbox('Чтобы зарегистрироваться, примите условия'),
    acceptPersonalData: requiredCheckbox('Нужно дать согласие на обработку персональных данных'),
    marketing: z.boolean(),
  })
  .refine(passwordsMatch, PASSWORDS_DIFFER)
  .transform(({ confirmPassword: _confirm, ...values }) => values)

export const resetPasswordRequestSchema = z.object({ email })

export const resetPasswordConfirmSchema = z
  .object({ password: newPassword, confirmPassword })
  .refine(passwordsMatch, PASSWORDS_DIFFER)
  .transform(({ password }) => ({ password }))

export type LoginFormInput = z.input<typeof loginSchema>
export type LoginFormValues = z.output<typeof loginSchema>
export type RegisterFormInput = z.input<typeof registerSchema>
export type RegisterFormValues = z.output<typeof registerSchema>
export type ResetPasswordRequestFormInput = z.input<typeof resetPasswordRequestSchema>
export type ResetPasswordRequestFormValues = z.output<typeof resetPasswordRequestSchema>
export type ResetPasswordConfirmFormInput = z.input<typeof resetPasswordConfirmSchema>
export type ResetPasswordConfirmFormValues = z.output<typeof resetPasswordConfirmSchema>
