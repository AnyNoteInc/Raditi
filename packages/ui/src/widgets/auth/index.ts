export { AuthHeader, type AuthHeaderProps } from './auth-header.tsx'
export {
  ConsentsCheckboxes,
  type ConsentDocumentLinks,
  type ConsentsCheckboxesProps,
} from './consents-checkboxes.tsx'
export { LoginForm, type LoginField, type LoginFormProps } from './login-form.tsx'
export { RegisterForm, type RegisterField, type RegisterFormProps } from './register-form.tsx'
export {
  RESET_REQUEST_SENT_MESSAGE,
  ResetPasswordRequestForm,
  type ResetPasswordRequestFormProps,
} from './reset-password-request-form.tsx'
export {
  ResetPasswordConfirmForm,
  type ResetPasswordConfirmFormProps,
} from './reset-password-confirm-form.tsx'
export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  loginSchema,
  registerSchema,
  resetPasswordConfirmSchema,
  resetPasswordRequestSchema,
  type LoginFormValues,
  type RegisterFormValues,
  type ResetPasswordConfirmFormValues,
  type ResetPasswordRequestFormValues,
} from './schemas.ts'
export type {
  AuthFormResult,
  AuthSubmitContext,
  AuthSubmitHandler,
  GetCaptchaToken,
} from './types.ts'
export { GENERIC_SUBMIT_ERROR } from './auth-submit.ts'
