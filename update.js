const fs = require('fs');
let arch = fs.readFileSync('ARCHITECTURE.md', 'utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
const replacements_arch = [
  [
    '- Config schema is Zod-validated; environment variables always override file config',
    [
      '- Config schema is Zod-validated; environment variables always override file config',
      '- Multi-Account load balancing supports proactive quota-aware rotation (Strategy 3) and cache-aware selection (Strategy 2) to prefer session-warm accounts',
      '- Connection warmup (Strategy 1) utilizes a lightweight streaming probe request upon account switches to prime server-side caches'
    ].join(String.fromCharCode(10))
  ],
  [
    [
      '**Multi-Account Management:**',
      '- Purpose: Track per-account OAuth state, rate-limit cooldowns, quota cache, fingerprints, and daily request usage; select the best account for each request; detect and repair auth storage drift; track session metrics and request rate estimation',
      '- Location: `src/plugin/accounts.ts`, `src/plugin/storage.ts`, `src/plugin/rotation.ts`, `src/plugin/fingerprint.ts`, `src/plugin/auth-doctor.ts`, `src/plugin/auth-drift.ts`',
      '- Contains: `AccountManager`, `HealthScoreTracker`, `TokenBucketTracker`, `selectHybridAccount`, `generateFingerprint`, `buildFingerprintHeaders`, `FingerprintVersion` history (max 5), account storage version 4 support with migration, secure POSIX permissions, `detectAuthStorageDrift`, `createAuthDoctorReport`, self-healing repairs, per-family daily request tracking, and in-memory session summaries with hourly rate calculations'
    ].join(String.fromCharCode(10)),
    [
      '**Multi-Account Management:**',
      '- Purpose: Track per-account OAuth state, rate-limit cooldowns, quota cache, fingerprints, and daily request usage; select the best account for each request; detect and repair auth storage drift; track session metrics and request rate estimation; manage proactive rotation and cache-aware selection preference',
      '- Location: `src/plugin/accounts.ts`, `src/plugin/storage.ts`, `src/plugin/rotation.ts`, `src/plugin/fingerprint.ts`, `src/plugin/auth-doctor.ts`, `src/plugin/auth-drift.ts`',
      '- Contains: `AccountManager` (implements proactive rotation `shouldProactivelyRotate` and `proactivelyRotateForFamily`, tracks session-warm accounts in `sessionUsedAccounts`), `HealthScoreTracker`, `TokenBucketTracker`, `selectHybridAccount`, `generateFingerprint`, `buildFingerprintHeaders`, `FingerprintVersion` history (max 5), account storage version 4 support with migration, secure POSIX permissions, `detectAuthStorageDrift`, `createAuthDoctorReport`, self-healing repairs, per-family daily request tracking, and in-memory session summaries with hourly rate calculations'
    ].join(String.fromCharCode(10))
  ],
  [
    'and paywall detection (`(unavailable)` status)',
    'and paywall detection (`(paid only)` status)'
  ],
  [
    [
      '**Request Transform Pipeline:**',
      '1. OpenCode calls plugin `loader()` with the original request — `src/plugin.ts`',
      '2. `isGenerativeLanguageRequest()` confirms the URL matches — `src/plugin/request.ts`',
      '3. `AccountManager.selectAccount()` picks the best OAuth account — `src/plugin/accounts.ts`',
      '4. `resolveModelWithTier()` maps model name → Antigravity model ID + header style — `src/plugin/transform/model-resolver.ts`',
      '5. `prepareAntigravityRequest()` cleans schema, strips thinking blocks for Claude, injects tool-hardening, and appends Claude thinking hints in a strict stable ordering (original prompt → tool hardening → thinking hint) to maximize prompt cache hits — `src/plugin/request.ts`, `src/plugin/request-helpers.ts`',
      '6. `buildFingerprintHeaders()` attaches per-account device fingerprint — `src/plugin/fingerprint.ts`',
      '7. `fetch()` is called against Antigravity endpoint with Bearer token — `src/plugin.ts`',
      '8. `accountManager.recordRequest()` tracks daily request usage per account and updates in-memory session request counts for rate consumption estimation — `src/plugin.ts`, `src/plugin/accounts.ts`',
      '9. `transformAntigravityResponse()` converts SSE stream back to Gemini API format — `src/plugin/request.ts`',
      '10. Streaming transformer processes each SSE line, caches signatures, injects debug annotations, and fires `onUsageMetadata` callback to log cache hit statistics upon stream termination — `src/plugin/core/streaming/`'
    ].join(String.fromCharCode(10)),
    [
      '**Request Transform Pipeline:**',
      '1. OpenCode calls plugin `loader()` with the original request — `src/plugin.ts`',
      '2. `isGenerativeLanguageRequest()` confirms the URL matches — `src/plugin/request.ts`',
      '3. `AccountManager.selectAccount()` picks the best OAuth account — `src/plugin/accounts.ts`',
      '4. `resolveModelWithTier()` maps model name → Antigravity model ID + header style — `src/plugin/transform/model-resolver.ts`',
      '5. `prepareAntigravityRequest()` cleans schema, strips thinking blocks for Claude, injects tool-hardening, and appends Claude thinking hints in a strict stable ordering (original prompt → tool hardening → thinking hint) to maximize prompt cache hits — `src/plugin/request.ts`, `src/plugin/request-helpers.ts`',
      '6. `buildFingerprintHeaders()` attaches per-account device fingerprint — `src/plugin/fingerprint.ts`',
      '7. If an account switch occurred and `cache_warmup_on_switch` is enabled, a lightweight cache warmup probe is sent using the exact request body but aborting after the first SSE chunk to warm the gateway-side cache — `src/plugin.ts`',
      '8. `fetch()` is called against Antigravity endpoint with Bearer token — `src/plugin.ts`',
      '9. `accountManager.recordRequest()` tracks daily request usage per account and updates in-memory session request counts for rate consumption estimation — `src/plugin.ts`, `src/plugin/accounts.ts`',
      '10. If the active account' + String.fromCharCode(39) + 's remaining quota drops below `proactive_rotation_threshold_percent` (default 20%), a proactive rotation switches the account to a session-warm or high-quota account for the next request — `src/plugin.ts`, `src/plugin/accounts.ts`',
      '11. `transformAntigravityResponse()` converts SSE stream back to Gemini API format — `src/plugin/request.ts`',
      '12. Streaming transformer processes each SSE line, caches signatures, injects debug annotations, and fires `onUsageMetadata` callback to log cache hit statistics upon stream termination — `src/plugin/core/streaming/`'
    ].join(String.fromCharCode(10))
  ],
  [
    [
      '**Quota Tracking & Refresh Flow:**',
      '1. Background refresh or user-triggered update invokes `checkAccountsQuota()` — `src/plugin.ts`',
      '2. `fetchAvailableModels()` and `fetchGeminiCliQuota()` query endpoints sequentially across `ANTIGRAVITY_ENDPOINT_FALLBACKS` — `src/plugin/quota.ts`',
      '3. Quota responses map to group-level (`cachedQuota`) and model-level (`cachedPerModelQuota`) summaries — `src/plugin/quota.ts`',
      '4. Active storage persists the updated summaries — `src/plugin/storage.ts`',
      '5. The terminal UI `showAuthMenu()` displays the status, treating stale cache values (0% remaining without a future reset time or reset time in the past) as `READY` (fail-open) and displaying paywalled Pro models as `(unavailable)` — `src/plugin/ui/auth-menu.ts`, `src/plugin/ui/quota-status.ts`'
    ].join(String.fromCharCode(10)),
    [
      '**Quota Tracking & Refresh Flow:**',
      '1. Background refresh or user-triggered update invokes `checkAccountsQuota()` — `src/plugin.ts`',
      '2. `fetchAvailableModels()` and `fetchGeminiCliQuota()` query endpoints sequentially across `ANTIGRAVITY_ENDPOINT_FALLBACKS` — `src/plugin/quota.ts`',
      '3. Quota responses map to group-level (`cachedQuota`) and model-level (`cachedPerModelQuota`) summaries — `src/plugin/quota.ts`',
      '4. Active storage persists the updated summaries — `src/plugin/storage.ts`',
      '5. The terminal UI `showAuthMenu()` displays the status, ignoring cached quota data older than 60 minutes as stale, treating valid 0% remaining without a future reset time or reset time in the past as `READY` (fail-open), and displaying paywalled Pro models as `(paid only)` — `src/plugin/ui/auth-menu.ts`, `src/plugin/ui/quota-status.ts`'
    ].join(String.fromCharCode(10))
  ],
  [
    [
      '**AccountManager:**',
      '- Purpose: Single source of truth for all OAuth accounts, their cooldowns, health scores, quota caches, fingerprints, and daily/session request metrics',
      '- Location: `src/plugin/accounts.ts`',
      '- Pattern: Stateful class with selection algorithms (`sticky`, `round-robin`, `hybrid`) delegating to `HealthScoreTracker` and `TokenBucketTracker`; tracks in-memory session stats and persists daily request counters on disk'
    ].join(String.fromCharCode(10)),
    [
      '**AccountManager:**',
      '- Purpose: Single source of truth for all OAuth accounts, their cooldowns, health scores, quota caches, fingerprints, and daily/session request metrics',
      '- Location: `src/plugin/accounts.ts`',
      '- Pattern: Stateful class with selection algorithms (`sticky`, `round-robin`, `hybrid`) delegating to `HealthScoreTracker` and `TokenBucketTracker`; tracks in-memory session stats, persists daily request counters on disk, manages proactive quota-aware rotation (Strategy 3), and tracks session-warm accounts (`sessionUsedAccounts`) to optimize cache-aware selection (Strategy 2)'
    ].join(String.fromCharCode(10))
  ],
  [
    'Prompt caching utilizes a strict prefix-stabilization ordering (stable system instructions first, dynamic content last) to maximize gateway-level cache hits.',
    'Prompt caching utilizes a strict prefix-stabilization ordering (stable system instructions first, dynamic content last) to maximize gateway-level cache hits. Connection caching and gateway-side caches are primed via lightweight cache warmup probes when switching accounts.'
  ],
  [
    'Config supports quota fallback disabling via quota_style_fallback: false, switches limit via max_account_switches: 2, and thinking warmup option 	hinking_warmup: false.',
    'Config supports quota fallback disabling via quota_style_fallback: false, switches limit via max_account_switches: 2, thinking warmup option 	hinking_warmup: false, cache warmup on account switch via cache_warmup_on_switch: true, and proactive rotation threshold via proactive_rotation_threshold_percent: 20.'
  ]
];
for (const [find, replace] of replacements_arch) {
  if (!arch.includes(find)) {
    console.error('Not found in ARCHITECTURE.md:', find);
    process.exit(1);
  }
  arch = arch.replace(find, replace);
}
fs.writeFileSync('ARCHITECTURE.md', arch, 'utf8');
console.log('ARCHITECTURE.md updated successfully');
let struct = fs.readFileSync('STRUCTURE.md', 'utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
const replacements_struct = [
  [
    '│       ├── accounts.ts           # AccountManager: selection, rotation, cooldowns, request counter and session metrics',
    '│       ├── accounts.ts           # AccountManager: selection, rotation, cooldowns, request counter, session metrics, proactive rotation, and cache-warm preference'
  ],
  [
    '**New account selection strategy:** src/plugin/accounts.ts — extend AccountSelectionStrategy union; add branch in AccountManager.selectAccount()',
    '**New account selection strategy:** src/plugin/rotation.ts — implement the selection algorithm; add selection mode option in src/plugin/config/schema.ts if needed, and call/wrap in src/plugin/accounts.ts'
  ]
];
for (const [find, replace] of replacements_struct) {
  if (!struct.includes(find)) {
    console.error('Not found in STRUCTURE.md:', find);
    process.exit(1);
