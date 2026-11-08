// Sign-in for the web app: better-auth with Yandex SmartCaptcha and 152-FZ consents.
export { auth, createAuth, getSessionFromHeaders, type Auth, type Session } from './auth.ts'
export { authConfigFromEnv, type AuthConfig } from './config.ts'
export {
  latestConsents,
  marketingConsentRow,
  requiredConsentRows,
  type ConsentContext,
  type ConsentRow,
} from './consents.ts'
export { profileLastNameSchema, profileNameSchema } from './profile-schema.ts'
export { clientIp, clientRateKey, requestMeta, type RequestMeta } from './request-meta.ts'
export { CAPTCHA_HEADER, validateSmartCaptcha, type CaptchaVerdict } from './smart-captcha.ts'
