# AGENTS.md

Guidance for AI agents working with this repository.

## Overview

OpenCode plugin for Google Antigravity OAuth. Intercepts `fetch()` calls to `generativelanguage.googleapis.com`, transforms them to Antigravity format, and handles auth, quota, recovery, and multi-account rotation.

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Add/modify request transform | `src/plugin/request.ts`, `src/plugin/request-helpers.ts` | Helper functions in request-helpers, orchestration in request |
| Add new model support | `src/plugin/model-registry.ts`, `src/plugin/transform/` | Register in `PUBLIC_MODEL_DEFINITIONS` + `MODEL_ALIASES`; add per-model logic in `claude.ts` or `gemini.ts` |
| Add config option | `src/plugin/config/schema.ts` | Add Zod field + default + JSDoc; update `DEFAULT_CONFIG`; add getter in `config/index.ts` |
| Change account selection | `src/plugin/rotation.ts`, `src/plugin/accounts.ts` | Algorithm in rotation, wiring in accounts |
| Add OpenCode hook | `src/hooks/[hook-name]/` | Follow `auto-update-checker/` structure |
| Add OpenCode tool | `src/plugin/search.ts` pattern | Implement function, register via `tool()` in `src/plugin.ts` |
| Add recovery type | `src/plugin/recovery/constants.ts` → `types.ts` → `index.ts` | Error string → type → handler |
| Add UI prompt | `src/plugin/ui/` | Follow `confirm.ts` or `select.ts` pattern |
| Debug request/response | `src/plugin/debug.ts` | Set `OPENCODE_ANTIGRAVITY_DEBUG=1` env var |
| Change quota logic | `src/plugin/quota.ts` | Endpoint fallbacks, per-model tracking, group summaries |
| Change auth flow | `src/antigravity/oauth.ts`, `src/plugin/auth.ts`, `src/plugin/token.ts` | OAuth exchange → validation → refresh |
| Change fingerprint | `src/plugin/fingerprint.ts` | `generateFingerprint`, `buildFingerprintHeaders` |
| Modify streaming | `src/plugin/core/streaming/transformer.ts` | SSE line transform, signature caching, usage metadata |

## Build & Test Commands

```bash
npm install                          # Install dependencies
npm run build                        # Compile (tsc -p tsconfig.build.json)
npm run typecheck                    # Type-check only (tsc --noEmit)
npm test                             # Run all tests (vitest run)
npx vitest run src/plugin/auth.test.ts          # Single test file
npx vitest run -t "test name here"              # Single test by name
npx vitest --watch src/plugin/auth.test.ts      # Watch mode, single file
npm run test:coverage                # Coverage report
npm run test:e2e:models              # E2E: model availability check
npm run test:e2e:regression          # E2E: regression suite
```

No linter or formatter is configured. Style is enforced by convention (see below).

## TypeScript Configuration

- `strict: true` with extra strictness: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `target: ESNext`, `module: Preserve`, `moduleResolution: bundler`
- `allowImportingTsExtensions: true` — use `.ts` extensions in imports
- No path aliases — all imports are relative

## Code Style

### Imports
- Use `import type { ... }` for type-only imports (enforced by `verbatimModuleSyntax`)
- Named imports only — no default imports in src/
- Relative paths with `.ts` extensions: `import { foo } from "./bar.ts"`
- Order: node builtins > external packages > local modules

### Exports
- Named exports only in src/ — no default exports
- Barrel files (index.ts) for module surfaces

### Naming
- `camelCase` for functions, variables, parameters
- `PascalCase` for types, interfaces, classes, enums
- `UPPER_SNAKE_CASE` for constants
- `kebab-case` for file names (e.g., `request-helpers.ts`, `thinking-recovery.ts`)
- Test files: `*.test.ts` colocated with source

### Types
- No `I` prefix on interfaces, no `Type` suffix
- Use `z.infer<typeof Schema>` for Zod-derived types
- Extract to `types.ts` when shared, inline when local
- Discriminated unions preferred over boolean flags
- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`

### Functions
- `export function` for public APIs
- Arrow functions for callbacks, factories, and inline closures
- Async functions with targeted try/catch (not blanket)

### Error Handling
- Defensive try/catch with graceful degradation (fallback values, not crashes)
- Custom error classes with metadata when domain-specific
- Catch `unknown`, log, and convert to domain errors — never empty catch blocks
- Rate limit / quota errors trigger account rotation, not failure

### Formatting
- 2-space indentation
- Double quotes for strings
- Trailing commas in multiline constructs
- No semicolons (project convention)

### Logging
- `createLogger("module-name")` for structured logging
- `console.log` only for CLI/user-facing output

## Module Structure

```
src/
├── plugin.ts                  # Main entry (168KB): fetch interceptor, retry loops, auth lifecycle
├── constants.ts               # Endpoints, headers, OAuth IDs, system prompts
├── antigravity/oauth.ts       # OAuth token exchange (authorize, exchange)
├── hooks/
│   └── auto-update-checker/   # Background npm version check + auto-pin on session.created
└── plugin/
    ├── accounts.ts            # AccountManager: selection, rotation, cooldowns, session metrics (58KB)
    ├── request.ts             # Core request/response transform pipeline (82KB)
    ├── request-helpers.ts     # Schema cleaning, thinking filters, tool helpers (97KB)
    ├── storage.ts             # Zod schemas for antigravity-accounts.json, file I/O (v4 format)
    ├── rotation.ts            # HealthScoreTracker, TokenBucketTracker, hybrid selection
    ├── quota.ts               # Quota API queries, endpoint fallbacks, per-model tracking
    ├── auth.ts / token.ts     # Token validation, refresh, AntigravityTokenRefreshError
    ├── recovery.ts            # Session recovery hook (tool_result_missing)
    ├── thinking-recovery.ts   # Turn-boundary detection, thinking block repair
    ├── fingerprint.ts         # Per-account device fingerprint generation & headers
    ├── project.ts             # Managed project context resolution (provision cache)
    ├── search.ts              # Google Search grounding tool (executeSearch)
    ├── model-registry.ts      # Centralized model specs, aliases, quota group mapping
    ├── cache.ts               # Auth token + thinking signature caching
    ├── errors.ts              # EmptyResponseError, domain error classes
    ├── debug.ts               # Debug file logging: request/response dumps
    ├── logger.ts              # createLogger("module-name") structured logging
    ├── cli.ts                 # Interactive terminal prompts (login, project ID)
    ├── server.ts              # Local OAuth callback HTTP listener
    ├── types.ts               # Shared interfaces: PluginResult, AuthDetails, PluginContext
    ├── config/                # Zod schema, file+env loader, model config, updater
    ├── transform/             # Model resolution + per-model transforms (claude, gemini, sanitizer)
    ├── recovery/              # Recovery subsystem (constants, types, storage, barrel)
    ├── cache/                 # SignatureCache (disk-backed thinking block signatures)
    ├── core/streaming/        # SSE line transformer, signature caching, usage metadata
    ├── stores/                # defaultSignatureStore singleton (in-memory)
    └── ui/                    # Terminal UI: auth menu, model/quota status, select/confirm
```

## Key Design Patterns

### 1. Request Interception
Plugin intercepts `fetch()` for `generativelanguage.googleapis.com`, transforms to Antigravity format. Two header styles: `antigravity` (Electron-style UA + fingerprint) and `gemini-cli` (nodejs-client UA).

### 2. Claude Thinking Blocks
ALL thinking blocks are stripped from outgoing requests for Claude models. Claude generates fresh thinking each turn. This eliminates signature validation errors.

### 3. Session Recovery
When tool execution is interrupted (ESC/timeout), the plugin injects synthetic `tool_result` blocks to recover the session without starting over.

### 4. Schema Sanitization
Tool schemas are cleaned via allowlist. Unsupported fields (`const`, `$ref`, `$defs`) are removed or converted to Antigravity-compatible format.

### 5. Multi-Account Load Balancing
Accounts rotate on rate limits. Gemini has dual quota pools (Antigravity headers + Gemini CLI headers). Fingerprints are per-account and regenerated on capacity exhaustion.

### 6. Fingerprint System
Per-account device fingerprints stored in `antigravity-accounts.json`. Each fingerprint includes deviceId, sessionToken, userAgent, and a reduced clientMetadata (ideType, platform, pluginType — no osVersion, arch, or sqmId). The only header composed is `User-Agent`, built by `buildFingerprintHeaders()` in `fingerprint.ts` and applied on the antigravity request path in `request.ts`. History tracked (max 5), restorable.

## Anti-Patterns (THIS PROJECT)

- **NEVER throw from `loader().fetch()`** — always return a synthetic HTTP error Response (503). Throwing corrupts OpenCode's session processor SQLite transaction.
- **NEVER use `as any`, `@ts-ignore`, `@ts-expect-error`** — strict TypeScript, no escape hatches.
- **NEVER generate synthetic Antigravity project IDs** — use only known/default project IDs. Random IDs cause 403 errors.
- **NEVER commit/push/publish without explicit user permission.**
- **NEVER add explicit `cache_control` markers** — Antigravity API rejects them with 400 errors. Caching is implicit prefix-based.
- **NEVER refactor while fixing a bug** — minimal fix only.
- **Empty catch blocks forbidden** — catch `unknown`, log, convert to domain errors.
- **No default exports in src/** — named exports only.
- **No semicolons** — project convention.
- **Fix one header/schema discrepancy at a time** — verify against real Antigravity IDE captures before implementing.

## Dependencies

- `zod ^4` — schema validation (NOT zod v3)
- `@opencode-ai/plugin` — OpenCode plugin interface
- `@openauthjs/openauth` — OAuth client
- `proper-lockfile` — file locking for concurrent access
- `xdg-basedir` — XDG directory resolution

## Testing

- Framework: **Vitest 3** with native ESM
- Config: `vitest.config.ts`
- Tests colocated: `src/plugin/foo.test.ts` next to `src/plugin/foo.ts`
- Use `describe`/`it`/`expect` — standard Vitest API
- Mock with `vi.fn()`, `vi.spyOn()`, `vi.mock()`

## Documentation

- [README.md](README.md) — Installation & usage
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Detailed architecture guide
- [docs/ANTIGRAVITY_API_SPEC.md](docs/ANTIGRAVITY_API_SPEC.md) — API wire-format reference
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — All config options, env vars, defaults
- [docs/MODEL-VARIANTS.md](docs/MODEL-VARIANTS.md) — Thinking budgets and variant system
- [docs/MULTI-ACCOUNT.md](docs/MULTI-ACCOUNT.md) — Load balancing, dual quota pools, account storage
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Common issues and resolution steps
- [CHANGELOG.md](CHANGELOG.md) — Version history
