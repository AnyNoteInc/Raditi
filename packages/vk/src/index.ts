// The adapter of VK API (docs/plan/99-vk-community.md, ВК14): implements the port `VkApi` of the
// domain; depends on the domain alone.
export { VkHttpApi, type VkFetch, type VkHttpApiOptions } from './api.ts'
export { DEV_VK_CONFIRM_SECRET, vkConfigFromEnv, type VkConfig } from './config.ts'
