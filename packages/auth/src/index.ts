// Sign-in for the web app: better-auth with Yandex SmartCaptcha and 152-FZ consents.
export {
  auth,
  createAuth,
  getAuth,
  getSessionFromHeaders,
  type Auth,
  type AuthNotifier,
  type CreateAuthOptions,
  type Session,
  type User,
} from './auth.ts'
export { authConfigFromEnv, type AuthConfig, type SmartCaptchaKeys } from './config.ts'
export {
  consentDocument,
  latestConsents,
  MARKETING_CONSENT,
  marketingConsentRow,
  requiredConsentCheckboxes,
  requiredConsentRows,
  signUpConsentRows,
  signUpConsentSchema,
  type ConsentContext,
  type ConsentRow,
  type RequiredConsentCheckbox,
  type SignUpConsent,
  type StoredConsent,
} from './consents.ts'
export {
  CONSENT_ERROR_CODES,
  consents,
  parseSignUpConsent,
  type ConsentWriter,
} from './consents-plugin.ts'
export { clientIp, requestMeta, type RequestMeta } from './request-meta.ts'
export {
  CAPTCHA_HEADER,
  CAPTCHA_PATHS,
  SMART_CAPTCHA_ERROR_CODES,
  smartCaptcha,
  SMARTCAPTCHA_VALIDATE_URL,
  validateSmartCaptcha,
  type CaptchaVerdict,
  type SmartCaptchaOptions,
  type ValidateSmartCaptchaInput,
} from './smart-captcha.ts'
