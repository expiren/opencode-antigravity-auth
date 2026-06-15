Hey! I've been doing extensive MITM capture analysis against real Antigravity IDE traffic (intercepting the Go language server via Proxifier + mitmproxy) and found several discrepancies in the fork that cause real production issues. Sharing these so you can fix them.

## Critical

### 1. Missing Gemini 3.1 Pro Route Table
The API has deprecated `gemini-3.1-pro-high` — it returns **400**. The active models are:
- **Low**: `gemini-3.1-pro-low` (thinkingBudget=1001)
- **High**: `gemini-pro-agent` (thinkingBudget=10001)

You only have `GEMINI_35_FLASH_ROUTES` but no equivalent for 3.1 Pro. Without a route table, all Pro High requests hit a deprecated endpoint.

### 2. No per-model API ID mapping for Claude
Real IDE sends:
- `claude-sonnet-4-6` (WITHOUT `-thinking` suffix) → works
- `claude-opus-4-6-thinking` (WITH `-thinking` suffix) → works

Without model-aware stripping, Sonnet gets sent with `-thinking` → **404**, or blanket stripping breaks Opus.

### 3. FNV-1a SessionId
Real IDE uses `FNV-1a(workspaceUri)` to produce a deterministic signed int64 sessionId (e.g. `-3750763034362895579`). This is workspace-stable across restarts, accounts, and conversations. Random/arbitrary sessionIds break server-side prompt cache continuity.

## High

### 4. `anthropic-beta` header still sent
Your `request.ts:1701-1709` still sends the `anthropic-beta: interleaved-thinking-*` header. The Antigravity proxy handles thinking server-side — this header is unnecessary and creates a fingerprint difference from real IDE traffic.

### 5. Extra request headers leaked to proxy
You only delete `x-session-affinity` from OpenCode's headers. Real IDE sends exactly 3 custom headers: `Authorization`, `Content-Type`, `User-Agent`. OpenCode injects `anthropic-version`, `x-stainless-*`, `Accept: text/event-stream`, etc. — all of which break the Antigravity proxy's JSON parsing (confirmed 400 errors).

Fix: Build headers from a clean slate instead of inheriting from `init.headers`.

### 6. No prefix-cache field stripping
You only delete `cachedContent` from `extra_body`. But `cache_control`/`cacheControl` on every content part, `providerOptions` on the payload, and `cachedContent` on the main body all leak through. Each extra field changes the byte-for-byte prefix hash, breaking Google's implicit prefix caching → full recompute on every request.

### 7. No per-session account pinning (subagent isolation)
Your `childSessionParentID` is toast-suppression only. Without a per-session `Map<childSessionId, { accountIndex, cursor, usedAccounts }>`, subagent requests evict the main conversation's warm cache bucket (99% → 56% hit rate drop). OpenCode sends `x-session-affinity` and `x-parent-session-id` headers for this purpose.

### 8. No ineligible account auto-disable
"Not eligible" 403 responses should permanently disable the account and persist to an ineligible accounts file, not retry the same dead account.

## Medium

### 9. Missing labels + structured requestId in envelope
Real IDE sends `labels` (inside `request`) with fields like `trajectory_id`, `model_enum`, `used_claude`, and uses structured `requestId` format: `agent/{conversationId}/{timestamp}/{trajectoryId}/{stepIndex}`.

### 10. Missing `toolConfig` with VALIDATED mode inside request
Real IDE includes `toolConfig: { functionCallingConfig: { mode: "VALIDATED" } }` inside the `request` object (you have this but worth verifying placement — it should be inside `request`, not at envelope top level).

---

All findings verified against real Antigravity IDE traffic captured via:
- Proxifier → mitmproxy (language server Go binary outbound)
- DevTools Network tab (Electron renderer)
- Direct API curl tests with multiple accounts

Happy to share more details on any of these.
