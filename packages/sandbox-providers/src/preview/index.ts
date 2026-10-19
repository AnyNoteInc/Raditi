// Previews of a dialog on the local Docker daemon (docs/plan/53-chat-preview-release.md, Р18).
export {
  dockerPreviewConfigSchema,
  previewRuntimeLimits,
  previewServiceLimits,
  type DockerPreviewConfig,
} from './config.ts'
export { createDockerPreviewRuntime } from './runtime.ts'
// SANDBOX_EGRESS_REFUSED_SUBNETS: the same variable the sandbox gateway reads (R10, Р13).
export { egressRefusedSubnetsVar } from '../gateway/config.ts'
