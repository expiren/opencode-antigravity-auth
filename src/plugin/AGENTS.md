# src/plugin/ — Core Plugin Subsystems

All runtime logic lives here. The parent `src/plugin.ts` orchestrates these modules but contains no reusable logic itself — it's the wiring layer.

## Subsystem Map

| Subsystem | Files | Purpose |
|-----------|-------|---------|
| **Request Pipeline** | `request.ts` (82KB), `request-helpers.ts` (97KB) | Transform OpenCode→Antigravity wire format and back. Schema cleaning, thinking-block stripping, empty-text sentinel normalization, tool-hardening injection, stable system-instruction ordering for prompt caching |
| **Account Management** | `accounts.ts` (58KB), `rotation.ts`, `fingerprint.ts`, `auth-doctor.ts`, `auth-drift.ts` | `AccountManager` class: selection algorithms (sticky/round-robin/hybrid), per-family cursors, cooldowns, session metrics, proactive rotation, cache-warm preference. `HealthScoreTracker` + `TokenBucketTracker` in rotation.ts |
| **Auth & Tokens** | `auth.ts`, `token.ts`, `refresh-queue.ts` | Token validation, `refreshAccessToken`, `AntigravityTokenRefreshError`, background proactive refresh queue |
| **Quota** | `quota.ts` | `checkAccountsQuota`, sequential endpoint fallbacks, parallel Antigravity+CLI fetches, per-model tracking (`cachedPerModelQuota`), stale-cache fail-open, paywall detection |
| **Storage** | `storage.ts` | Zod schemas for `antigravity-accounts.json` (v4 format), `atomicWriteFile` with Windows retry/fallback, `proper-lockfile` concurrent-write safety, daily request counters |
| **Recovery** | `recovery.ts`, `recovery/` | `createSessionRecoveryHook` detects `tool_result_missing` errors, injects synthetic completions. Sub-module: `constants.ts` (error strings), `types.ts`, `storage.ts` (state persistence) |
| **Thinking Recovery** | `thinking-recovery.ts` | Turn-boundary detection, thinking block repair, compacted-thinking detection — separate from session recovery |
| **Model Registry** | `model-registry.ts` | `PUBLIC_MODEL_DEFINITIONS`, `MODEL_ALIASES`, `QUOTA_GROUP_BY_MODEL_ID`, `RESOLVER_ALIASES` — single source of truth for model specs |
| **Search Tool** | `search.ts` | `executeSearch` — Google Search grounding via separate Antigravity API calls |
| **Project Context** | `project.ts` | Managed project resolution with provision cache, `provisionFailedKeys` Set blocks retry floods, cleared on `invalid_grant` or "Check Quotas" |
| **Debug** | `debug.ts` | File-based request/response logging, enabled via `OPENCODE_ANTIGRAVITY_DEBUG=1` |
| **Logging** | `logger.ts`, `logging-utils.ts` | `createLogger("module-name")` with dual sinks (TUI + file). ANSI helpers in logging-utils |
| **Errors** | `errors.ts` | `EmptyResponseError` and typed domain error classes |
| **Cache** | `cache.ts` | Auth token Map + in-memory thinking signature cache; re-exports `SignatureCache` from `cache/` |
| **Image Saver** | `image-saver.ts` | Save Gemini image-generation output to disk |
| **CLI** | `cli.ts`, `server.ts` | Interactive terminal prompts (login, project ID), local OAuth callback HTTP listener |
| **Version** | `version.ts` | Runtime Antigravity version fetch + setter |

## Subdirectories

### `transform/`
Model resolution and per-model payload transforms. Barrel: `index.ts`.
- `model-resolver.ts` — `resolveModelWithTier`, `resolveModelWithVariant`, `resolveModelForHeaderStyle`; maps model names to Antigravity IDs + header style (`antigravity` vs `gemini-cli`)
- `claude.ts` — Claude thinking config, tool-hardening system instructions, token limits
- `gemini.ts` — Gemini 3/2.5 thinking config, image generation support
- `cross-model-sanitizer.ts` — Strip incompatible fields when switching between model families
- `types.ts` — `TransformContext`, `ResolvedModel`, `ThinkingConfig`

### `config/`
Config loading and validation. Barrel: `index.ts`.
- `schema.ts` — `AntigravityConfigSchema` (Zod), `DEFAULT_CONFIG`, all config fields with JSDoc
- `loader.ts` — Merges project file (`.opencode/antigravity.json`) + user file (`~/.config/opencode/antigravity.json`) + env vars
- `models.ts` — Model-specific config helpers
- `updater.ts` — Config file writer for auto-update pin changes

### `recovery/`
Session recovery subsystem. Barrel: `index.ts`.
- `constants.ts` — Recovery error string patterns (9 constants)
- `types.ts` — Recovery types (16 type definitions)
- `storage.ts` — Recovery state persistence helpers

### `cache/`
Disk-backed thinking signature cache. Barrel: `index.ts`.
- `signature-cache.ts` — `SignatureCache` class with in-memory + JSON file persistence, background flush, TTL

### `core/streaming/`
Low-level SSE stream transformer. Barrel: `index.ts`.
- `transformer.ts` — `createStreamingTransformer`, `transformSseLine`, `onUsageMetadata` callback for cache hit-rate logging
- `types.ts` — `SignatureStore`, `StreamingCallbacks`, `StreamingOptions`, `StreamingUsageMetadata`

### `stores/`
Shared singletons.
- `signature-store.ts` — `defaultSignatureStore` (in-memory `Map`-based `SignatureStore`)

### `ui/`
Terminal UI primitives for interactive auth flow and status display.
- `auth-menu.ts` — Multi-account auth menu with tier separators, model availability breakdowns
- `model-status.ts` — Per-model status aggregation across accounts
- `quota-status.ts` — Quota status labels, stale-cache fail-open, ANSI badge formatting
- `ansi.ts` — ANSI colour helpers
- `confirm.ts` — Y/n prompt
- `select.ts` — Arrow-key selection list

## Key Conventions (This Directory Only)

- **Three mega-files**: `request-helpers.ts` (97KB), `request.ts` (82KB), `accounts.ts` (58KB) are intentionally large — they're cohesive modules, not candidates for splitting
- **Barrel pattern**: Subdirectories expose public API via `index.ts`; consumers import from the barrel, not internal files
- **Per-family isolation**: `AccountManager` uses `cursorByFamily: Record<ModelFamily, number>` for independent per-family round-robin, not a shared cursor
- **Child session isolation**: `AccountManager.childSessions` Map keyed by `childSessionId` provides per-session account pinning to prevent cross-session cache eviction
- **Fail-open everywhere**: Quota checks, soft-quota thresholds, and stale-cache scenarios all fail open (allow the request) rather than blocking
- **Never throw from fetch path**: All failure paths return synthetic HTTP error `Response` objects (503), never thrown exceptions
- **Transform ordering matters**: Claude transforms execute in fixed sequence: cross-model sanitization → unsigned thinking stripping → cache injection → warmup check → tool ID assignment → hint appending
