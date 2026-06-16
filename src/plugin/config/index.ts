/**
 * Configuration module for opencode-antigravity-auth plugin.
 * 
 * @example
 * ```typescript
 * import { loadConfig, type AntigravityConfig } from "./config";
 * 
 * const config = loadConfig(directory);
 * if (config.session_recovery) {
 *   // Enable session recovery
 * }
 * ```
 */

export {
  AntigravityConfigSchema,
  DEFAULT_CONFIG,
  type AntigravityConfig,
  type SignatureCacheConfig,
} from "./schema";

export {
  loadConfig,
  initRuntimeConfig,
  getKeepThinking,
  getClaudeSentinelText,
  getUseRawTransport,
  getResponseTimeoutMs,
} from "./loader";
