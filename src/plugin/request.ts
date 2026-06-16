import crypto from "node:crypto";
import {
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  SKIP_THOUGHT_SIGNATURE,
  getRandomizedHeaders,
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  CLAUDE_DESCRIPTION_PROMPT,
  type HeaderStyle,
} from "../constants"
import { cacheSignature, getCachedSignature } from "./cache"
import { getKeepThinking, getClaudeSentinelText } from "./config";
import {
  createStreamingTransformer,
  transformSseLine,
  transformStreamingPayload,
} from "./core/streaming";
import { defaultSignatureStore } from "./stores/signature-store";
import {
  DEBUG_MESSAGE_PREFIX,
  isDebugTuiEnabled,
  logAntigravityDebugResponse,
  logCacheStats,
  type AntigravityDebugContext,
} from "./debug";
import { createLogger } from "./logger";
import {
  cleanJSONSchemaForAntigravity,
  DEFAULT_THINKING_BUDGET,
  deepFilterThinkingBlocks,
  extractThinkingConfig,
  extractVariantThinkingConfig,
  extractUsageFromSsePayload,
  extractUsageMetadata,
  fixToolResponseGrouping,
  validateAndFixClaudeToolPairing,
  applyToolPairingFixes,
  injectParameterSignatures,
  injectToolHardeningInstruction,
  isThinkingCapableModel,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  resolveThinkingConfig,
  rewriteAntigravityPreviewAccessError,
  transformThinkingParts,
  type AntigravityApiBody,
} from "./request-helpers";
import {
  analyzeConversationState,
  closeToolLoopForThinking,
  needsThinkingRecovery,
} from "./thinking-recovery";
import {
  isGemini3Model,
  isImageGenerationModel,
  buildImageGenerationConfig,
  applyGeminiTransforms,
  resolveModelForHeaderStyle,
  isClaudeModel,
  isClaudeThinkingModel,
  computeClaudeMaxOutputTokens,
  ensureClaudeMaxOutputTokens,
  sanitizeCrossModelPayloadInPlace,
  type ThinkingTier,
  type GoogleSearchConfig,
  appendClaudeThinkingHint,
} from "./transform"
import { detectErrorType } from "./recovery"
import { getSessionFingerprint, buildFingerprintHeaders, type Fingerprint } from "./fingerprint";

const log = createLogger("request");

const PLUGIN_SESSION_ID = `-${crypto.randomUUID()}`;

// Structured requestId tracking — matches real Antigravity IDE format:
// Checkpoint: "checkpoint/{uuid}"
// Agent:      "agent/{conversationId}/{timestamp}/{trajectoryId}/{stepIndex}"
const CONVERSATION_ID = crypto.randomUUID();
const TRAJECTORY_ID = crypto.randomUUID();
let requestStepIndex = 0;

export function buildAntigravityRequestId(type: "agent" | "checkpoint" = "agent"): string {
  if (type === "checkpoint") {
    return `checkpoint/${crypto.randomUUID()}`;
  }
  const timestamp = Date.now().toString();
  const id = `agent/${CONVERSATION_ID}/${timestamp}/${TRAJECTORY_ID}/${requestStepIndex}`;
  requestStepIndex++;
  return id;
}
// FNV-1a 64-bit hash — deterministic sessionId matching real Antigravity IDE
// Real IDE computes FNV-1a(workspaceUri) — stable across accounts, restarts, conversations
const FNV1A_64_OFFSET_BASIS = 0xCBF29CE484222325n
const FNV1A_64_PRIME = 0x00000100000001B3n

export function fnv1a64(input: string): string {
  let hash = FNV1A_64_OFFSET_BASIS
  const bytes = Buffer.from(input, "utf-8")
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME)
  }
  // Convert to signed 64-bit integer string (matching real IDE format)
  const signed = hash > 0x7FFFFFFFFFFFFFFFn
    ? hash - 0x10000000000000000n
    : hash
  return signed.toString()
}

// Deterministic session ID from workspace directory (FNV-1a 64-bit hash)
// Default: empty string input = FNV-1a offset basis = "-3750763034362895579"
let NUMERIC_SESSION_ID = fnv1a64("")

export function initSessionId(directory: string): void {
  NUMERIC_SESSION_ID = fnv1a64(directory)
}

// Per-model API ID mapping — real Antigravity API model IDs differ from our internal names.
// Sonnet: claude-sonnet-4-6-thinking → claude-sonnet-4-6 (proxy strips -thinking server-side)
// Opus:   claude-opus-4-6-thinking   → claude-opus-4-6-thinking (API requires the suffix)
const CLAUDE_API_MODEL_IDS: Record<string, string> = {
  "claude-sonnet-4-6-thinking": "claude-sonnet-4-6",
  // Opus keeps the -thinking suffix — real API model ID includes it
  "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
}

function toApiModelId(effectiveModel: string): string {
  return CLAUDE_API_MODEL_IDS[effectiveModel] ?? effectiveModel;
}

// Deterministic envelope field ordering — matches real Antigravity IDE JSON key order
// for byte-for-byte prefix cache stability
const ANTIGRAVITY_ENVELOPE_FIELD_ORDER = [
  "project",
  "requestId",
  "request",
  "model",
  "userAgent",
  "requestType",
] as const

export function orderAntigravityEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}
  const remaining = new Set(Object.keys(body))

  for (const key of ANTIGRAVITY_ENVELOPE_FIELD_ORDER) {
    if (key in body) {
      ordered[key] = body[key]
      remaining.delete(key)
    }
  }

  for (const key of remaining) {
    ordered[key] = body[key]
  }

  return ordered
}

// Per-model maxOutputTokens from real Antigravity fetchAvailableModels API
// Ensures generationConfig.maxOutputTokens matches API-reported limits
const AGY_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "gemini-3.5-flash-low": 65536,
  "gemini-3.5-flash-extra-low": 65536,
  "gemini-3-flash-agent": 65536,
  "gemini-3.1-pro-low": 65535,
  "gemini-pro-agent": 65535,
  "claude-sonnet-4-6": 64000,
  "claude-opus-4-6-thinking": 64000,
  "gpt-oss-120b": 32768,
  "gpt-oss-120b-medium": 32768,
  "gemini-3.1-flash-image": 33000,
  "gemini-3.1-flash-lite": 65536,
}

function applyAgyGenerationDefaults(model: string, requestPayload: Record<string, unknown>, headerStyle: string): void {
  if (headerStyle !== "antigravity") {
    return
  }
  const maxOutput = AGY_MAX_OUTPUT_TOKENS[model.toLowerCase()]
  if (maxOutput === undefined) {
    return
  }
  const gen = requestPayload.generationConfig as Record<string, unknown> | undefined
  if (!gen || typeof gen !== "object") {
    return
  }
  gen.maxOutputTokens = maxOutput
  delete gen.max_output_tokens
}
let lastExecutionId = crypto.randomUUID()

const sessionDisplayedThinkingHashes = new Set<string>();

const MIN_SIGNATURE_LENGTH = 50;

function buildSignatureSessionKey(
  sessionId: string,
  model?: string,
  conversationKey?: string,
  projectKey?: string,
): string {
  const modelKey = typeof model === "string" && model.trim() ? model.toLowerCase() : "unknown";
  const projectPart = typeof projectKey === "string" && projectKey.trim()
    ? projectKey.trim()
    : "default";
  const conversationPart = typeof conversationKey === "string" && conversationKey.trim()
    ? conversationKey.trim()
    : "default";
  return `${sessionId}:${modelKey}:${projectPart}:${conversationPart}`;
}

/**
 * JSON.stringify replacer — operates AT the serialization layer.
 * Every key-value pair passes through this function during stringify.
 * Nothing can bypass it — no code path, no nesting depth, no object structure.
 *
 * Preserves Schema objects in tool declarations (e.g., {type: "boolean"})
 * by checking for JSON Schema primitive types. Everything else that's
 * a non-string `thinking` value gets flattened to "".
 */
const JSON_SCHEMA_TYPES = new Set(["boolean", "string", "number", "integer", "array", "object"])

function thinkingSafeReplacer(key: string, value: unknown): unknown {
  if (key === "thinking" && typeof value === "object" && value !== null) {
    // Preserve Schema objects in tool declarations (e.g., {type: "boolean"})
    const rec = value as Record<string, unknown>
    if (typeof rec.type === "string" && JSON_SCHEMA_TYPES.has(rec.type)) {
      return value
    }
    // Flatten any non-string, non-Schema thinking to empty string
    return ""
  }
  return value
}

/** Stringify with built-in thinking sanitization. Impossible to bypass. */
function ensureThinkingFields(obj: unknown): void {
  if (!obj || typeof obj !== "object") return
  if (Array.isArray(obj)) {
    for (const item of obj) ensureThinkingFields(item)
    return
  }
  const rec = obj as Record<string, unknown>
  // Fix: check for missing OR undefined OR non-string thinking field.
  // JSON.stringify silently drops undefined values, so key-exists-but-undefined
  // produces { type: "thinking", signature: "..." } with NO thinking field.
  if (rec.type === "thinking" && typeof rec.thinking !== "string") {
    rec.thinking = ""
  }
  if (rec.thought === true && typeof rec.text !== "string") {
    rec.text = ""
  }
  for (const val of Object.values(rec)) {
    ensureThinkingFields(val)
  }
}

function safeStringify(obj: unknown): string {
  ensureThinkingFields(obj)
  return JSON.stringify(obj, thinkingSafeReplacer)
}





function shouldCacheThinkingSignatures(model?: string): boolean {
  if (typeof model !== "string") return false;
  const lower = model.toLowerCase();
  // Both Claude and Gemini 3 models require thought signature caching
  // for multi-turn conversations with function calling
  return lower.includes("claude") || lower.includes("gemini-3");
}

function hashConversationSeed(seed: string): string {
  return crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const anyBlock = block as any;
    if (typeof anyBlock.text === "string") {
      return anyBlock.text;
    }
    if (anyBlock.text && typeof anyBlock.text === "object" && typeof anyBlock.text.text === "string") {
      return anyBlock.text.text;
    }
  }
  return "";
}

function extractConversationSeedFromMessages(messages: any[]): string {
  const system = messages.find((message) => message?.role === "system");
  const users = messages.filter((message) => message?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
  const systemText = system ? extractTextFromContent(system.content) : "";
  const userText = firstUser ? extractTextFromContent(firstUser.content) : "";
  const fallbackUserText = !userText && lastUser ? extractTextFromContent(lastUser.content) : "";
  return [systemText, userText || fallbackUserText].filter(Boolean).join("|");
}

function extractConversationSeedFromContents(contents: any[]): string {
  const users = contents.filter((content) => content?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
  const primaryUser = firstUser && Array.isArray(firstUser.parts) ? extractTextFromContent(firstUser.parts) : "";
  if (primaryUser) {
    return primaryUser;
  }
  if (lastUser && Array.isArray(lastUser.parts)) {
    return extractTextFromContent(lastUser.parts);
  }
  return "";
}

function resolveConversationKey(requestPayload: Record<string, unknown>): string | undefined {
  const anyPayload = requestPayload as any;
  const candidates = [
    anyPayload.conversationId,
    anyPayload.conversation_id,
    anyPayload.thread_id,
    anyPayload.threadId,
    anyPayload.chat_id,
    anyPayload.chatId,
    anyPayload.sessionId,
    anyPayload.session_id,
    anyPayload.metadata?.conversation_id,
    anyPayload.metadata?.conversationId,
    anyPayload.metadata?.thread_id,
    anyPayload.metadata?.threadId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const systemSeed = extractTextFromContent(
    (anyPayload.systemInstruction as any)?.parts
    ?? anyPayload.systemInstruction
    ?? anyPayload.system
    ?? anyPayload.system_instruction,
  );
  const messageSeed = Array.isArray(anyPayload.messages)
    ? extractConversationSeedFromMessages(anyPayload.messages)
    : Array.isArray(anyPayload.contents)
      ? extractConversationSeedFromContents(anyPayload.contents)
      : "";
  const seed = [systemSeed, messageSeed].filter(Boolean).join("|");
  if (!seed) {
    return undefined;
  }
  return `seed-${hashConversationSeed(seed)}`;
}

function resolveConversationKeyFromRequests(requestObjects: Array<Record<string, unknown>>): string | undefined {
  for (const req of requestObjects) {
    const key = resolveConversationKey(req);
    if (key) {
      return key;
    }
  }
  return undefined;
}

function resolveProjectKey(candidate?: unknown, fallback?: string): string | undefined {
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

function formatDebugLinesForThinking(lines: string[]): string {
  const cleaned = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-50);
  const prelude = `[ThinkingResolution] source=debug_tui lines=${cleaned.length}`;
  return `${DEBUG_MESSAGE_PREFIX}\n- ${prelude}\n${cleaned.map((line) => `- ${line}`).join("\n")}`;
}

function injectDebugThinking(response: unknown, debugText: string): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }

  const resp = response as any;

  if (Array.isArray(resp.candidates) && resp.candidates.length > 0) {
    const candidates = resp.candidates.slice();
    const first = candidates[0];

    if (
      first &&
      typeof first === "object" &&
      first.content &&
      typeof first.content === "object" &&
      Array.isArray(first.content.parts)
    ) {
      const parts = [{ thought: true, text: debugText }, ...first.content.parts];
      candidates[0] = { ...first, content: { ...first.content, parts } };
      return { ...resp, candidates };
    }

    return resp;
  }

  if (Array.isArray(resp.content)) {
    const content = [{ type: "thinking", thinking: debugText }, ...resp.content];
    return { ...resp, content };
  }

  if (!resp.reasoning_content) {
    return { ...resp, reasoning_content: debugText };
  }

  return resp;
}

/**
 * Synthetic thinking placeholder text used when keep_thinking=true but debug mode is off.
 * Injected via the same path as debug text (injectDebugThinking) to ensure consistent
 * signature caching and multi-turn handling.
 */
const SYNTHETIC_THINKING_PLACEHOLDER = "[Thinking preserved]\n";

function stripInjectedDebugFromParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) {
    return parts;
  }

  // Use .map() with empty text sentinels instead of .filter() to preserve
  // array indices and prevent prompt cache invalidation.
  return parts.map((part) => {
    if (!part || typeof part !== "object") {
      return part;
    }

    const record = part as any;
    const text =
      typeof record.text === "string"
        ? record.text
        : typeof record.thinking === "string"
          ? record.thinking
          : undefined;

    // Replace debug blocks and synthetic thinking placeholders with empty text sentinel
    if (text && (text.startsWith(DEBUG_MESSAGE_PREFIX) || text.startsWith(SYNTHETIC_THINKING_PLACEHOLDER.trim()))) {
      const sentinel: Record<string, unknown> = { text: "" };
      if (record.cache_control !== undefined) sentinel.cache_control = record.cache_control;
      return sentinel;
    }

    return part;
  });
}
function stripInjectedDebugFromRequestPayload(payload: Record<string, unknown>): void {
  const anyPayload = payload as any;

  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents.map((content: any) => {
      if (!content || typeof content !== "object") {
        return content;
      }

      if (Array.isArray(content.parts)) {
        return { ...content, parts: stripInjectedDebugFromParts(content.parts) };
      }

      if (Array.isArray(content.content)) {
        return { ...content, content: stripInjectedDebugFromParts(content.content) };
      }

      return content;
    });
  }

  if (Array.isArray(anyPayload.messages)) {
    anyPayload.messages = anyPayload.messages.map((message: any) => {
      if (!message || typeof message !== "object") {
        return message;
      }

      if (Array.isArray(message.content)) {
        return { ...message, content: stripInjectedDebugFromParts(message.content) };
      }

      return message;
    });
  }
}

function isValidRequestPart(part: unknown): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  const record = part as Record<string, unknown>;

  return (
    Object.prototype.hasOwnProperty.call(record, "text") ||
    Object.prototype.hasOwnProperty.call(record, "functionCall") ||
    Object.prototype.hasOwnProperty.call(record, "functionResponse") ||
    Object.prototype.hasOwnProperty.call(record, "inlineData") ||
    Object.prototype.hasOwnProperty.call(record, "fileData") ||
    Object.prototype.hasOwnProperty.call(record, "executableCode") ||
    Object.prototype.hasOwnProperty.call(record, "codeExecutionResult") ||
    Object.prototype.hasOwnProperty.call(record, "thought")
  );
}

function sanitizeRequestPayloadForAntigravity(payload: Record<string, unknown>, isClaudeRequest = false): void {
  const anyPayload = payload as any;

  if (Array.isArray(anyPayload.contents)) {
    // Use .map() instead of .map().filter() to preserve array indices for prompt cache stability
    anyPayload.contents = anyPayload.contents
      .map((content: unknown) => {
        if (!content || typeof content !== "object") {
          return { role: "user", parts: [{ text: "" }] };
        }

        const contentRecord = content as Record<string, unknown>;
        const rawParts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
        let foundFirstFunctionCall = false;

        const emptyTextValue = isClaudeRequest ? getClaudeSentinelText() : ""
        const sanitizedParts = rawParts.map((part: any) => {
          if (!isValidRequestPart(part)) {
            return { text: emptyTextValue };
          }
          if (part.text !== undefined && (typeof part.text !== "string" || part.text.trim().length === 0)) {
            const sentinel: Record<string, unknown> = { text: emptyTextValue };
            return sentinel;
          }
          return part;
        }).map((part: any) => {
          if (part && typeof part === "object" && part.functionCall) {
            let sig = part.thoughtSignature || part.thought_signature;

            // Only the first functionCall part in a block should have the signature.
            // If it's the first one and missing a valid signature, inject the sentinel
            // to prevent the API from rejecting the request with a 400 error.
            if (!foundFirstFunctionCall) {
              foundFirstFunctionCall = true;
              if (!sig || sig.length < MIN_SIGNATURE_LENGTH) {
                sig = SKIP_THOUGHT_SIGNATURE;
              }
            } else {
              // Parallel function calls MUST NOT have a signature
              sig = undefined;
            }

            if (sig) {
              return { ...part, thoughtSignature: sig };
            }
            
            // If not the first part, just return the part without adding any signature keys
            const newPart = { ...part };
            delete newPart.thoughtSignature;
            delete newPart.thought_signature;
            return newPart;
          }
          return part;
        });

        if (sanitizedParts.length === 0) {
          return { ...contentRecord, parts: [{ text: isClaudeRequest ? getClaudeSentinelText() : "" }] };
        }

        return {
          ...contentRecord,
          parts: sanitizedParts,
        };
      });
  }

  if (Array.isArray(anyPayload.messages)) {
    anyPayload.messages = anyPayload.messages.map((message: unknown) => {
      if (!message || typeof message !== "object") {
        return { role: "user", content: [{ type: "text", text: "" }] }
      }

      const messageRecord = message as Record<string, unknown>
      const rawContent = Array.isArray(messageRecord.content) ? messageRecord.content : messageRecord.content

      if (!Array.isArray(rawContent)) {
        return messageRecord
      }

      const sanitizedContent = rawContent.map((block: unknown) => {
        if (!block || typeof block !== "object") {
          return { type: "text", text: "" }
        }

        const blockRecord = block as Record<string, unknown>
        if (blockRecord.type === "text") {
          const text = blockRecord.text
          if (typeof text !== "string" || text.trim().length === 0) {
            const sentinelText = isClaudeRequest ? getClaudeSentinelText() : ""
            const sentinel: Record<string, unknown> = { type: "text", text: sentinelText }
            return sentinel
          }
        }

        return block
      })

      if (sanitizedContent.length === 0) {
        return { ...messageRecord, content: [{ type: "text", text: isClaudeRequest ? getClaudeSentinelText() : "" }] }
      }

      return {
        ...messageRecord,
        content: sanitizedContent,
      }
    })
  }

  const systemInstruction = anyPayload.systemInstruction;
  if (systemInstruction && typeof systemInstruction === "object" && !Array.isArray(systemInstruction)) {
    const sys = systemInstruction as Record<string, unknown>;
    if (Array.isArray(sys.parts)) {
      // Use .map() with sentinels instead of .filter() to preserve array indices
      // and prevent prompt cache invalidation from index shifts.
      const sanitizedSystemParts = sys.parts.map((part: unknown) => {
        if (isValidRequestPart(part)) return part;
        const sentinel: Record<string, unknown> = { text: "" };
        if (part && typeof part === "object") {
          const cc = (part as Record<string, unknown>).cache_control;
          if (cc !== undefined) sentinel.cache_control = cc;
        }
        return sentinel;
      });
      const hasRealContent = sanitizedSystemParts.some((p: any) =>
        p && typeof p === "object" && typeof p.text === "string" && p.text !== "" && p.text.trim().length > 0
      );
      if (hasRealContent) {
        sys.parts = sanitizedSystemParts;
      } else {
        delete anyPayload.systemInstruction;
      }
    }  }
}

function isGeminiToolUsePart(part: any): boolean {
  return !!(part && typeof part === "object" && (part.functionCall || part.tool_use || part.toolUse));
}

function isGeminiThinkingPart(part: any): boolean {
  return !!(
    part &&
    typeof part === "object" &&
    (part.thought === true || part.type === "thinking" || part.type === "reasoning")
  );
}

// Sentinel value used when signature recovery fails - allows Claude to handle gracefully
// by redacting the thinking block instead of rejecting the request entirely.
// Reference: LLM-API-Key-Proxy uses this pattern for Gemini 3 tool calls.
const SENTINEL_SIGNATURE = "skip_thought_signature_validator";

function getThinkingPartText(part: any): string {
  if (!part || typeof part !== "object") {
    return "";
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  if (typeof part.thinking === "string") {
    return part.thinking;
  }

  return "";
}

function hasCachedMatchingSignature(part: any, sessionId: string): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  const text = getThinkingPartText(part);
  if (!text) {
    return false;
  }

  const expectedSignature = getCachedSignature(sessionId, text);
  if (!expectedSignature) {
    return false;
  }

  if (part.thought === true) {
    return part.thoughtSignature === expectedSignature;
  }

  return part.signature === expectedSignature;
}

function ensureThoughtSignature(part: any, sessionId: string): any {
  if (!part || typeof part !== "object") {
    return part;
  }

  if (!sessionId) {
    return part;
  }

  const text = getThinkingPartText(part);
  if (!text) {
    return part;
  }

  if (part.thought === true) {
    return { ...part, thoughtSignature: SENTINEL_SIGNATURE };
  }

  if (part.type === "thinking" || part.type === "reasoning" || part.type === "redacted_thinking") {
    return { ...part, signature: SENTINEL_SIGNATURE };
  }

  return part;
}

function hasSignedThinkingPart(part: any, sessionId?: string): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  if (part.thought === true) {
    if (part.thoughtSignature === SENTINEL_SIGNATURE || part.thoughtSignature === SKIP_THOUGHT_SIGNATURE) {
      return true;
    }

    if (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length < MIN_SIGNATURE_LENGTH) {
      return false;
    }

    if (!sessionId) {
      return true;
    }

    return hasCachedMatchingSignature(part, sessionId);
  }

  if (part.type === "thinking" || part.type === "reasoning" || part.type === "redacted_thinking") {
    if (part.signature === SENTINEL_SIGNATURE || part.signature === SKIP_THOUGHT_SIGNATURE) {
      return true;
    }

    if (typeof part.signature !== "string" || part.signature.length < MIN_SIGNATURE_LENGTH) {
      return false;
    }

    if (!sessionId) {
      return true;
    }

    return hasCachedMatchingSignature(part, sessionId);
  }

  return false;
}

function ensureThinkingBeforeToolUseInContents(contents: any[], signatureSessionKey: string): any[] {
  return contents.map((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return content;
    }

    const role = content.role;
    if (role !== "model" && role !== "assistant") {
      return content;
    }

    const parts = content.parts as any[];
    const hasToolUse = parts.some(isGeminiToolUsePart);
    if (!hasToolUse) {
      return content;
    }

    // Check if any thinking part has a valid signed signature
    const hasSignedThinking = parts.some(p => isGeminiThinkingPart(p) && hasSignedThinkingPart(ensureThoughtSignature(p, signatureSessionKey), signatureSessionKey));

    if (hasSignedThinking) {
      // Ensure signatures on thinking parts in-place — NO reordering to preserve array indices (cache-friendly)
      return { ...content, parts: parts.map(p => isGeminiThinkingPart(p) ? ensureThoughtSignature(p, signatureSessionKey) : p) };
    }
    // Replace thinking parts with sentinels in-place to preserve array indices (cache-friendly).
    // Deleting parts via .filter() shifts array indices → changes hash → busts prompt cache.
    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    log.debug("Replacing thinking with sentinels in-place", { signatureSessionKey, hasCachedSig: !!lastThinking });
    const newParts = parts.map(p => {
      if (!isGeminiThinkingPart(p)) return p;
      const cc = (p as Record<string, unknown>).cache_control;
      const sentinel: Record<string, unknown> = { text: getClaudeSentinelText() };
      if (cc) sentinel.cache_control = cc;
      return sentinel;
    });
    return { ...content, parts: newParts };
  });
}
function ensureMessageThinkingSignature(block: any, sessionId: string): any {
  if (!block || typeof block !== "object") {
    return block;
  }

  if (block.type !== "thinking" && block.type !== "redacted_thinking") {
    return block;
  }

  const text = getThinkingPartText(block);
  if (!text) {
    return block;
  }

  if (!sessionId) {
    return block;
  }

  return { ...block, signature: SKIP_THOUGHT_SIGNATURE };
}

function hasToolUseInContents(contents: any[]): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return (content.parts as any[]).some(isGeminiToolUsePart);
  });
}

function hasSignedThinkingInItems(
  items: any[],
  innerArrayKey: string,
  sessionId?: string,
): boolean {
  return items.some((item: any) => {
    if (!item || typeof item !== "object" || !Array.isArray(item[innerArrayKey])) {
      return false
    }
    return (item[innerArrayKey] as any[]).some((part) => hasSignedThinkingPart(part, sessionId))
  })
}

function hasSignedThinkingInContents(contents: any[], sessionId?: string): boolean {
  return hasSignedThinkingInItems(contents, "parts", sessionId)
}

function hasSignedThinkingInMessages(messages: any[], sessionId?: string): boolean {
  return hasSignedThinkingInItems(messages, "content", sessionId)
}

function hasToolUseInMessages(messages: any[]): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return (message.content as any[]).some(
      (block) => block && typeof block === "object" && (block.type === "tool_use" || block.type === "tool_result"),
    );
  });
}

function ensureThinkingBeforeToolUseInMessages(messages: any[], signatureSessionKey: string): any[] {
  return messages.map((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return message;
    }

    if (message.role !== "assistant") {
      return message;
    }

    const blocks = message.content as any[];
    const hasToolUse = blocks.some((b) => b && typeof b === "object" && (b.type === "tool_use" || b.type === "tool_result"));
    if (!hasToolUse) {
      return message;
    }

    const isThinkingBlock = (b: any) => b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking");

    // Check if any thinking block has a valid signed signature
    const hasSignedThinking = blocks.some((b) => isThinkingBlock(b) && hasSignedThinkingPart(ensureMessageThinkingSignature(b, signatureSessionKey), signatureSessionKey));

    if (hasSignedThinking) {
      // Ensure signatures on thinking blocks in-place — NO reordering to preserve array indices (cache-friendly)
      return { ...message, content: blocks.map((b) => isThinkingBlock(b) ? ensureMessageThinkingSignature(b, signatureSessionKey) : b) };
    }

    // Replace thinking blocks with sentinels in-place to preserve array indices (cache-friendly).
    // Deleting/reordering via .filter() shifts indices → changes hash → busts prompt cache.
    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    log.debug("Replacing thinking with sentinels in-place (Messages format)", { signatureSessionKey, hasCachedSig: !!lastThinking });
    return { ...message, content: blocks.map((b) => {
      if (!isThinkingBlock(b)) return b;
      const cc = (b as Record<string, unknown>).cache_control;
      const sentinel: Record<string, unknown> = { text: getClaudeSentinelText() };
      if (cc) sentinel.cache_control = cc;
      return sentinel;
    }) };
  });
}
/**
 * Gets the stable session ID for this plugin instance.
 */
export function getPluginSessionId(): string {
  return PLUGIN_SESSION_ID;
}

const _lastCacheStatsByFamily: Record<string, { model: string; read: number; total: number; hitRate: number }> = {};

export function getLastCacheStats(family?: string) {
  if (!family) return null
  return _lastCacheStatsByFamily[family] ?? null
}

/** Shared cache/usage stats logging for both streaming and non-streaming paths. */
function recordUsageStats(
  usage: { cachedContentTokenCount?: number; promptTokenCount?: number; totalTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number },
  model: string,
): void {
  const cacheRead = usage.cachedContentTokenCount ?? 0
  const totalInput = usage.promptTokenCount ?? usage.totalTokenCount ?? 0
  const hitRate = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0
  const status = cacheRead > 0 ? "HIT" : "MISS"
  const thinkingTokens = usage.thoughtsTokenCount ?? 0
  const outputTokens = (usage.candidatesTokenCount ?? 0) + thinkingTokens
  const statsFamily = model.includes("claude") ? "claude" : "gemini"
  _lastCacheStatsByFamily[statsFamily] = { model, read: cacheRead, total: totalInput, hitRate }
  logCacheStats(model, cacheRead, 0, totalInput);
  log.debug(`[Cache] ${status} model=${model} read=${cacheRead} total=${totalInput} hitRate=${hitRate}%`)
  if (thinkingTokens > 0) {
    log.debug(`[Usage] model=${model} output=${outputTokens} (candidates=${usage.candidatesTokenCount ?? 0} thinking=${thinkingTokens})`)
  }
}
const STREAM_ACTION = "streamGenerateContent";

/**
 * Extract a URL string from any fetch() input shape (string, URL, or Request).
 */
export function fetchInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  // Request-like object
  const url = (input as Request).url
  return typeof url === "string" ? url : String(input)
}

/**
 * Detects requests headed to the Google Generative Language API so we can
 * intercept them. Handles string, URL, and Request inputs — matching on URL
 * only would let `fetch(new Request(...))` / `fetch(new URL(...))` bypass the
 * interceptor entirely.
 */
export function isGenerativeLanguageRequest(input: RequestInfo | URL): boolean {
  return fetchInputToUrl(input).includes("generativelanguage.googleapis.com")
}

/**
 * Options for request preparation.
 */
export interface PrepareRequestOptions {
  /** Enable Claude tool hardening (parameter signatures + system instruction). Default: true */
  claudeToolHardening?: boolean;
  /** Enable top-level Claude prompt auto-caching (`cache_control`). Default: false */
  claudePromptAutoCaching?: boolean;
  /** Google Search configuration (global default) */
  googleSearch?: GoogleSearchConfig;
  /** Per-account fingerprint for rate limit mitigation. Falls back to session fingerprint if not provided. */
  fingerprint?: Fingerprint;
}

export function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  endpointOverride?: string,
  headerStyle: HeaderStyle = "antigravity",
  forceThinkingRecovery = false,
  options?: PrepareRequestOptions,
): {
  request: RequestInfo;
  init: RequestInit;
  streaming: boolean;
  requestedModel?: string;
  effectiveModel?: string;
  projectId?: string;
  endpoint?: string;
  sessionId?: string;
  toolDebugMissing?: number;
  toolDebugSummary?: string;
  toolDebugPayload?: string;
  needsSignedThinkingWarmup?: boolean;
  headerStyle: HeaderStyle;
  thinkingRecoveryMessage?: string;
} {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  let resolvedProjectId = projectId?.trim() || "";
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];
  let toolDebugPayload: string | undefined;
  let sessionId: string | undefined;
  let needsSignedThinkingWarmup = false;
  let thinkingRecoveryMessage: string | undefined;

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  // Strip x-goog-user-project header to prevent 403 auth/license conflicts.
  // This header is added by OpenCode/AI SDK and can force project-level checks
  // that are not required for Antigravity/Gemini CLI OAuth requests.
  headers.delete("x-goog-user-project");

  const inputUrl = fetchInputToUrl(input);
  const match = inputUrl.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const requestedModel = rawModel;

  const resolved = resolveModelForHeaderStyle(rawModel, headerStyle);
  let effectiveModel = resolved.actualModel;

  const streaming = rawAction === STREAM_ACTION;
  const defaultEndpoint = headerStyle === "gemini-cli" ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
  const baseEndpoint = endpointOverride ?? defaultEndpoint;
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;

  const isClaude = isClaudeModel(resolved.actualModel);
  const isClaudeThinking = isClaudeThinkingModel(resolved.actualModel);  const keepThinkingEnabled = getKeepThinking();

  // Tier-based thinking configuration from model resolver (can be overridden by variant config)
  let tierThinkingBudget = resolved.thinkingBudget;
  let tierThinkingLevel = resolved.thinkingLevel;
  let signatureSessionKey = buildSignatureSessionKey(
    PLUGIN_SESSION_ID,
    effectiveModel,
    undefined,
    resolveProjectKey(projectId),
  );

  let body = baseInit.body;
  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>;
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;

      if (isWrapped) {        const wrappedBody = {
          ...parsedBody,
          model: toApiModelId(effectiveModel),
        } as Record<string, unknown>;

        // Some callers may already send an Antigravity-wrapped body.
        // We still need to sanitize Claude thinking blocks (remove cache_control)
        // and attach a stable sessionId so multi-turn signature caching works.
        const requestRoot = wrappedBody.request;
        const requestObjects: Array<Record<string, unknown>> = [];

        if (requestRoot && typeof requestRoot === "object") {
          requestObjects.push(requestRoot as Record<string, unknown>);
          const nested = (requestRoot as any).request;
          if (nested && typeof nested === "object") {
            requestObjects.push(nested as Record<string, unknown>);
          }
        }

        const conversationKey = resolveConversationKeyFromRequests(requestObjects);
        // Strip tier suffix from model for cache key to prevent cache misses on tier change
        // e.g., "claude-opus-4-6-thinking-high" -> "claude-opus-4-6-thinking"
        const modelForCacheKey = effectiveModel.replace(/-(minimal|low|medium|high)$/i, "");
        signatureSessionKey = buildSignatureSessionKey(PLUGIN_SESSION_ID, modelForCacheKey, conversationKey, resolveProjectKey(parsedBody.project));

        if (requestObjects.length > 0) {
          sessionId = signatureSessionKey;
        }

        for (const req of requestObjects) {
          // Strip any nested sessionId from individual request objects
          delete (req as any).sessionId;
          stripInjectedDebugFromRequestPayload(req as Record<string, unknown>);

          if (isClaude) {
            // Step 0: Sanitize cross-model metadata (strips Gemini signatures when sending to Claude)
            sanitizeCrossModelPayloadInPlace(req, { targetModel: effectiveModel });

          // Step 1: Strip corrupted/unsigned thinking blocks FIRST
          deepFilterThinkingBlocks(req, signatureSessionKey, getCachedSignature, true);

          // Step 2: THEN inject signed thinking from cache (after stripping)
            if (isClaudeThinking && keepThinkingEnabled && Array.isArray((req as any).contents)) {
              (req as any).contents = ensureThinkingBeforeToolUseInContents((req as any).contents, signatureSessionKey);
            }
            if (isClaudeThinking && keepThinkingEnabled && Array.isArray((req as any).messages)) {
              (req as any).messages = ensureThinkingBeforeToolUseInMessages((req as any).messages, signatureSessionKey);
            }

            // Step 3: Apply tool pairing fixes (ID assignment, response matching, orphan recovery)
            applyToolPairingFixes(req as Record<string, unknown>, true);
          }
        }

        // Guard against assistant prefill: Claude rejects conversations ending
        // with model/assistant messages. After context compaction, the conversation
        // can end with a model message — append synthetic user message to fix.
        if (isClaude) {
          for (const req of requestObjects) {
            if (Array.isArray((req as any).contents)) {
              const contents = (req as any).contents;
              const lastContent = contents[contents.length - 1];
              if (lastContent?.role === "model" || lastContent?.role === "assistant") {
                contents.push({ role: "user", parts: [{ text: "[Continue]" }] });
              }
            }
            if (Array.isArray((req as any).messages)) {
              const messages = (req as any).messages;
              const lastMessage = messages[messages.length - 1];
              if (lastMessage?.role === "model" || lastMessage?.role === "assistant") {
                messages.push({ role: "user", content: [{ type: "text", text: "[Continue]" }] });
              }
            }
          }
        }

        if (isClaudeThinking && keepThinkingEnabled && sessionId) {
          const hasToolUse = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasToolUseInContents((req as any).contents)) ||
            (Array.isArray((req as any).messages) && hasToolUseInMessages((req as any).messages)),
          );          const hasSignedThinking = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasSignedThinkingInContents((req as any).contents, signatureSessionKey)) ||
            (Array.isArray((req as any).messages) && hasSignedThinkingInMessages((req as any).messages, signatureSessionKey)),
          );
          const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
          needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
        }

        body = safeStringify(wrappedBody);
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody };
        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
        const extraBody = requestPayload.extra_body as Record<string, unknown> | undefined;

        const variantConfig = extractVariantThinkingConfig(
          requestPayload.providerOptions as Record<string, unknown> | undefined,
          rawGenerationConfig
        );
        // Delete providerOptions — used for variant extraction above but must not leak to wire
        // Real Antigravity IDE sends zero providerOptions fields
        delete requestPayload.providerOptions;
        const isGemini3 = effectiveModel.toLowerCase().includes("gemini-3");

        log.debug(`[ThinkingResolution] rawModel=${rawModel} resolvedModel=${effectiveModel} resolvedTier=${tierThinkingLevel ?? "none"} variantLevel=${variantConfig?.thinkingLevel ?? "none"} variantBudget=${variantConfig?.thinkingBudget ?? "none"} providerOptions.google=${JSON.stringify((requestPayload.providerOptions as any)?.google ?? null)} generationConfig.thinkingConfig=${JSON.stringify((rawGenerationConfig as any)?.thinkingConfig ?? null)}`);

        if (variantConfig?.thinkingLevel && isGemini3) {
          // Gemini 3 native format - use thinkingLevel directly
          const variantModelBase = rawModel
            .replace(/-preview-customtools$/i, "")
            .replace(/-preview$/i, "")
            .replace(/-(minimal|low|medium|high)$/i, "");
          const variantResolved = resolveModelForHeaderStyle(
            `${variantModelBase}-${variantConfig.thinkingLevel}`,
            headerStyle,
          );

          effectiveModel = variantResolved.actualModel;
          tierThinkingLevel = variantResolved.thinkingLevel ?? variantConfig.thinkingLevel;
          tierThinkingBudget = undefined;
        } else if (variantConfig?.thinkingBudget) {
          if (isGemini3) {
            // Legacy format for Gemini 3 - convert with deprecation warning
            log.warn("[Deprecated] Using thinkingBudget for Gemini 3 model. Use thinkingLevel instead.");
            tierThinkingLevel = variantConfig.thinkingBudget <= 8192 ? "low"
              : variantConfig.thinkingBudget <= 16384 ? "medium" : "high";
            tierThinkingBudget = undefined;
          } else {
            // Claude / Gemini 2.5 - use budget directly
            tierThinkingBudget = variantConfig.thinkingBudget;
            tierThinkingLevel = undefined;
          }
        }

        if (isClaude) {
          if (!requestPayload.toolConfig) {
            requestPayload.toolConfig = {};
          }
          if (typeof requestPayload.toolConfig === "object") {
            const toolConfig = requestPayload.toolConfig as Record<string, unknown>;
            if (!toolConfig.functionCallingConfig) {
              toolConfig.functionCallingConfig = {};
            }
            if (typeof toolConfig.functionCallingConfig === "object") {
              (toolConfig.functionCallingConfig as Record<string, unknown>).mode = "VALIDATED";
            }
          }
        }

        // Resolve thinking configuration based on user settings and model capabilities
        // Image generation models don't support thinking - skip thinking config entirely
        const isImageModel = isImageGenerationModel(effectiveModel);
        const userThinkingConfig = isImageModel ? undefined : extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody);
        const hasAssistantHistory = Array.isArray(requestPayload.contents) &&
          requestPayload.contents.some((c: any) => c?.role === "model" || c?.role === "assistant");

        // Claude Sonnet 4.6 is non-thinking only.
        // Ignore any client-provided thinkingConfig for this model.
        const lowerEffective = effectiveModel.toLowerCase();
        const isClaudeSonnetNonThinking = lowerEffective === "claude-sonnet-4-6";
        const effectiveUserThinkingConfig = (isClaudeSonnetNonThinking || isImageModel) ? undefined : userThinkingConfig;

        // For image models, add imageConfig instead of thinkingConfig
        if (isImageModel) {
          const imageConfig = buildImageGenerationConfig();
          const generationConfig = (rawGenerationConfig ?? {}) as Record<string, unknown>;
          generationConfig.imageConfig = imageConfig;
          // Remove any thinkingConfig that might have been set
          delete generationConfig.thinkingConfig;
          // Set reasonable defaults for image generation
          if (!generationConfig.candidateCount) {
            generationConfig.candidateCount = 1;
          }
          requestPayload.generationConfig = generationConfig;

          // Add safety settings for image generation (permissive to allow creative content)
          if (!requestPayload.safetySettings) {
            requestPayload.safetySettings = [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
            ];
          }

          // Image models don't support tools - remove them entirely
          delete requestPayload.tools;
          delete requestPayload.toolConfig;

          // Replace system instruction with a simple image generation prompt
          // Image models should not receive agentic coding assistant instructions
          requestPayload.systemInstruction = {
            parts: [{ text: "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request." }]
          };
        } else {
          const finalThinkingConfig = resolveThinkingConfig(
            effectiveUserThinkingConfig,
            isClaudeSonnetNonThinking ? false : (resolved.isThinkingModel ?? isThinkingCapableModel(effectiveModel)),
            isClaude,
            hasAssistantHistory,
          );

          const normalizedThinking = normalizeThinkingConfig(finalThinkingConfig);
          if (normalizedThinking) {
            // Use tier-based thinking budget if specified via model suffix, otherwise fall back to user config
            const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;

            // Build thinking config based on model type
            let thinkingConfig: Record<string, unknown>;

            if (isClaudeThinking) {
              // Claude uses camelCase keys (matching real Antigravity IDE format)
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts ?? true,
                ...(typeof thinkingBudget === "number" && thinkingBudget > 0
                  ? { thinkingBudget }
                  : {}),
              };
            } else if (tierThinkingLevel) {
              // Gemini 3 uses thinkingLevel string (low/medium/high)
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                thinkingLevel: tierThinkingLevel,
              };
            } else {
              // Gemini 2.5 and others use numeric budget
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                ...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
              };
            }

            if (rawGenerationConfig) {
              rawGenerationConfig.thinkingConfig = thinkingConfig;

              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                ensureClaudeMaxOutputTokens(rawGenerationConfig, thinkingBudget);
              }
              requestPayload.generationConfig = rawGenerationConfig;
            } else {
              const generationConfig: Record<string, unknown> = { thinkingConfig };

              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                generationConfig.maxOutputTokens = computeClaudeMaxOutputTokens(thinkingBudget);
              }
              requestPayload.generationConfig = generationConfig;
            }
          } else if (rawGenerationConfig?.thinkingConfig) {
            delete rawGenerationConfig.thinkingConfig;
            requestPayload.generationConfig = rawGenerationConfig;
          }
        } // End of else block for non-image models

        // Clean up thinking fields from extra_body
        if (extraBody) {
          delete extraBody.thinkingConfig;
          delete extraBody.thinking;
        }
        delete requestPayload.thinkingConfig;
        delete requestPayload.thinking;

        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction;
          delete requestPayload.system_instruction;
        }

        // Delete all cachedContent variants — real Antigravity IDE sends zero cachedContent
        // The Antigravity proxy handles caching server-side via prefix matching
        delete requestPayload.cached_content;
        delete requestPayload.cachedContent;
        if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
          delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
          delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
          if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
            delete requestPayload.extra_body;
          }
        }
        // Normalize tools. For Claude models, keep full function declarations (names + schemas).
        const hasTools = Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0;

        if (hasTools) {
          if (isClaude) {
            const functionDeclarations: any[] = [];
            const passthroughTools: any[] = [];

            const normalizeSchema = (schema: any) => {
              const createPlaceholderSchema = (base: any = {}) => ({
                ...base,
                type: "object",
                properties: {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
                  },
                },
                required: [EMPTY_SCHEMA_PLACEHOLDER_NAME],
              });

              if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }

              const cleaned = cleanJSONSchemaForAntigravity(schema);

              if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }

              // Claude VALIDATED mode requires tool parameters to be an object schema
              // with at least one property.
              const hasProperties =
                cleaned.properties &&
                typeof cleaned.properties === "object" &&
                Object.keys(cleaned.properties).length > 0;

              cleaned.type = "object";

              if (!hasProperties) {
                cleaned.properties = {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
                  },
                };
                cleaned.required = Array.isArray(cleaned.required)
                  ? Array.from(new Set([...cleaned.required, EMPTY_SCHEMA_PLACEHOLDER_NAME]))
                  : [EMPTY_SCHEMA_PLACEHOLDER_NAME];
              }

              return cleaned;
            };

            (requestPayload.tools as any[]).forEach((tool: any) => {
              const pushDeclaration = (decl: any, source: string) => {
                const schema =
                  decl?.parameters ||
                  decl?.parametersJsonSchema ||
                  decl?.input_schema ||
                  decl?.inputSchema ||
                  tool.parameters ||
                  tool.parametersJsonSchema ||
                  tool.input_schema ||
                  tool.inputSchema ||
                  tool.function?.parameters ||
                  tool.function?.parametersJsonSchema ||
                  tool.function?.input_schema ||
                  tool.function?.inputSchema ||
                  tool.custom?.parameters ||
                  tool.custom?.parametersJsonSchema ||
                  tool.custom?.input_schema;

                let name =
                  decl?.name ||
                  tool.name ||
                  tool.function?.name ||
                  tool.custom?.name ||
                  `tool-${functionDeclarations.length}`;

                // Sanitize tool name: must be alphanumeric with underscores, no special chars
                name = String(name).replace(/[^a-zA-Z0-9_]/g, "_");
                if (name.length > 0 && !/^[A-Za-z_]/.test(name)) { name = "_" + name; }
                name = name.slice(0, 64);

                const description =
                  decl?.description ||
                  tool.description ||
                  tool.function?.description ||
                  tool.custom?.description ||
                  "";

                functionDeclarations.push({
                  name,
                  description: String(description || ""),
                  parameters: normalizeSchema(schema),
                });

                toolDebugSummaries.push(
                  `decl=${name},src=${source},hasSchema=${schema ? "y" : "n"}`,
                );
              };

              if (Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) {
                tool.functionDeclarations.forEach((decl: any) => pushDeclaration(decl, "functionDeclarations"));
                return;
              }

              // Fall back to function/custom style definitions.
              if (
                tool.function ||
                tool.custom ||
                tool.parameters ||
                tool.input_schema ||
                tool.inputSchema
              ) {
                pushDeclaration(tool.function ?? tool.custom ?? tool, "function/custom");
                return;
              }

              // Preserve any non-function tool entries (e.g., codeExecution) untouched.
              passthroughTools.push(tool);
            });

            const finalTools: any[] = [];
            if (functionDeclarations.length > 0) {
              finalTools.push({ functionDeclarations });
            }
            requestPayload.tools = finalTools.concat(passthroughTools);
          } else {
            // Gemini-specific tool normalization and feature injection
            const geminiResult = applyGeminiTransforms(requestPayload, {
              model: effectiveModel,
              normalizedThinking: undefined, // Thinking config already applied above (lines 816-880)
              tierThinkingBudget,
              tierThinkingLevel: tierThinkingLevel as ThinkingTier | undefined,
            });

            toolDebugMissing = geminiResult.toolDebugMissing;
            toolDebugSummaries.push(...geminiResult.toolDebugSummaries);
          }

          try {
            toolDebugPayload = JSON.stringify(requestPayload.tools);
          } catch {
            toolDebugPayload = undefined;
          }

          // Apply Claude tool hardening (ported from LLM-API-Key-Proxy)
          // Injects parameter signatures into descriptions and adds system instruction
          // Can be disabled via config.claude_tool_hardening = false to reduce context size
          const enableToolHardening = options?.claudeToolHardening ?? true;
          if (enableToolHardening && isClaude && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
            // Inject parameter signatures into tool descriptions
            requestPayload.tools = injectParameterSignatures(
              requestPayload.tools,
              CLAUDE_DESCRIPTION_PROMPT,
            );

            // Inject tool hardening system instruction
            injectToolHardeningInstruction(
              requestPayload as Record<string, unknown>,
              CLAUDE_TOOL_SYSTEM_INSTRUCTION,
            );
          }

          // Append interleaved thinking hint for Claude thinking models with tools.
          // Must come AFTER tool hardening so it is the last system instruction part,
          // preserving the stable prefix for prompt cache matching.
          if (isClaudeThinking && Array.isArray(requestPayload.tools) && (requestPayload.tools as unknown[]).length > 0) {
            appendClaudeThinkingHint(requestPayload as Record<string, unknown>);
          }
        }
        const conversationKey = resolveConversationKey(requestPayload);
        signatureSessionKey = buildSignatureSessionKey(PLUGIN_SESSION_ID, effectiveModel, conversationKey, resolveProjectKey(projectId));

        // For Claude models, filter out unsigned thinking blocks (required by Claude API)
        // Attempts to restore signatures from cache for multi-turn conversations
        // Handle both Gemini-style contents[] and Anthropic-style messages[] payloads.
        if (isClaude) {
          // Step 0: Sanitize cross-model metadata (strips Gemini signatures when sending to Claude)
          sanitizeCrossModelPayloadInPlace(requestPayload, { targetModel: effectiveModel });

          // Step 1: Strip corrupted/unsigned thinking blocks FIRST
          deepFilterThinkingBlocks(requestPayload, signatureSessionKey, getCachedSignature, true);

          // Step 2: THEN inject signed thinking from cache (after stripping)
          if (isClaudeThinking && keepThinkingEnabled && Array.isArray(requestPayload.contents)) {
            requestPayload.contents = ensureThinkingBeforeToolUseInContents(requestPayload.contents, signatureSessionKey);
          }
          if (isClaudeThinking && keepThinkingEnabled && Array.isArray(requestPayload.messages)) {
            requestPayload.messages = ensureThinkingBeforeToolUseInMessages(requestPayload.messages, signatureSessionKey);
          }

          // Step 3: Check if warmup needed (AFTER injection attempt)
          if (isClaudeThinking && keepThinkingEnabled) {
            const hasToolUse =
              (Array.isArray(requestPayload.contents) && hasToolUseInContents(requestPayload.contents)) ||
              (Array.isArray(requestPayload.messages) && hasToolUseInMessages(requestPayload.messages));
            const hasSignedThinking =
              (Array.isArray(requestPayload.contents) && hasSignedThinkingInContents(requestPayload.contents, signatureSessionKey)) ||
              (Array.isArray(requestPayload.messages) && hasSignedThinkingInMessages(requestPayload.messages, signatureSessionKey));
            const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
            needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
          }
        } else {
          // For non-Claude models (Gemini): strip historical thinking blocks for cache stability.
          // Gemini regenerates fresh thinking each turn — keeping old thinking blocks causes
          // cache busts when MC execute passes replace thinking content with sentinels.
          deepFilterThinkingBlocks(requestPayload, signatureSessionKey, getCachedSignature, false);
        }

        // For Claude models, ensure functionCall/tool use parts carry IDs (required by Anthropic).
        // We use a two-pass approach: first collect all functionCalls and assign IDs,
        // then match functionResponses to their corresponding calls using a FIFO queue per function name.
        if (isClaude && Array.isArray(requestPayload.contents)) {
          let toolCallCounter = 0;
          // Track pending call IDs per function name as a FIFO queue
          const pendingCallIdsByName = new Map<string, string[]>();

          // First pass: assign IDs to all functionCalls and collect them
          requestPayload.contents = requestPayload.contents.map((content: any) => {
            if (!content || !Array.isArray(content.parts)) {
              return content;
            }

            const newParts = content.parts.map((part: any) => {
              if (part && typeof part === "object" && part.functionCall) {
                const call = { ...part.functionCall };
                if (!call.id) {
                  call.id = `tool-call-${++toolCallCounter}`;
                }
                const nameKey = typeof call.name === "string" ? call.name : `tool-${toolCallCounter}`;
                // Push to the queue for this function name
                const queue = pendingCallIdsByName.get(nameKey) || [];
                queue.push(call.id);
                pendingCallIdsByName.set(nameKey, queue);
                return { ...part, functionCall: call };
              }
              return part;
            });

            return { ...content, parts: newParts };
          });

          // Second pass: match functionResponses to their corresponding calls (FIFO order)
          requestPayload.contents = (requestPayload.contents as any[]).map((content: any) => {
            if (!content || !Array.isArray(content.parts)) {
              return content;
            }

            const newParts = content.parts.map((part: any) => {
              if (part && typeof part === "object" && part.functionResponse) {
                const resp = { ...part.functionResponse };
                if (!resp.id && typeof resp.name === "string") {
                  const queue = pendingCallIdsByName.get(resp.name);
                  if (queue && queue.length > 0) {
                    // Consume the first pending ID (FIFO order)
                    resp.id = queue.shift();
                    pendingCallIdsByName.set(resp.name, queue);
                  }
                }
                return { ...part, functionResponse: resp };
              }
              return part;
            });

            return { ...content, parts: newParts };
          });

          // Third pass: Apply orphan recovery for mismatched tool IDs
          // This handles cases where context compaction or other processes
          // create ID mismatches between calls and responses.
          // Ported from LLM-API-Key-Proxy's _fix_tool_response_grouping()
          requestPayload.contents = fixToolResponseGrouping(requestPayload.contents as any[]);
        }

        // Fourth pass: Fix Claude format tool pairing (defense in depth)
        // Handles orphaned tool_use blocks in Claude's messages[] format
        if (Array.isArray(requestPayload.messages)) {
          requestPayload.messages = validateAndFixClaudeToolPairing(requestPayload.messages);
        }

        // =====================================================================
        // LAST RESORT RECOVERY: "Let it crash and start again"
        // =====================================================================
        // If after all our processing we're STILL in a bad state (tool loop without
        // thinking at turn start), don't try to fix it - just close the turn and
        // start fresh. This prevents permanent session breakage.
        //
        // This handles cases where:
        // - Context compaction stripped thinking blocks
        // - Signature cache miss
        // - Any other corruption we couldn't repair
        // - API error indicated thinking_block_order issue (forceThinkingRecovery=true)
        //
        // The synthetic messages allow Claude to generate fresh thinking on the
        // new turn instead of failing with "Expected thinking but found text".
        if (isClaudeThinking && Array.isArray(requestPayload.contents)) {
          const conversationState = analyzeConversationState(requestPayload.contents);

          // Force recovery if API returned thinking_block_order error (retry case)
          // or if proactive check detects we need recovery
          if (forceThinkingRecovery || needsThinkingRecovery(conversationState)) {
            // Set message for toast notification (shown in plugin.ts, respects quiet mode)
            thinkingRecoveryMessage = forceThinkingRecovery
              ? "Thinking recovery: retrying with fresh turn (API error)"
              : "Thinking recovery: restarting turn (corrupted context)";

            requestPayload.contents = closeToolLoopForThinking(requestPayload.contents);

            defaultSignatureStore.delete(signatureSessionKey);
          }
        }

        // Guard against assistant prefill: Claude rejects conversations ending
        // with model/assistant messages. After context compaction, the conversation
        // can end with a model message — append synthetic user message to fix.
        if (isClaude) {
          if (Array.isArray(requestPayload.contents)) {
            const lastContent = requestPayload.contents[requestPayload.contents.length - 1] as any;
            if (lastContent?.role === "model" || lastContent?.role === "assistant") {
              requestPayload.contents.push({ role: "user", parts: [{ text: "[Continue]" }] });
            }
          }
          if (Array.isArray(requestPayload.messages)) {
            const lastMessage = (requestPayload.messages as any[])[requestPayload.messages.length - 1];
            if (lastMessage?.role === "model" || lastMessage?.role === "assistant") {
              (requestPayload.messages as any[]).push({ role: "user", content: [{ type: "text", text: "[Continue]" }] });
            }
          }
        }

        if ("model" in requestPayload) {
          delete requestPayload.model;
        }

        stripInjectedDebugFromRequestPayload(requestPayload);
        sanitizeRequestPayloadForAntigravity(requestPayload, isClaude);
        applyAgyGenerationDefaults(effectiveModel, requestPayload, headerStyle);

        // Inject fields inside request payload matching real Antigravity IDE format
        // sessionId, labels, toolConfig go INSIDE request (not envelope top level)
        if (headerStyle === "antigravity") {
          // Session ID — stable signed integer string per plugin session
          requestPayload.sessionId = NUMERIC_SESSION_ID

          // Labels — tracking metadata for agent requests
          const claudeUsed = isClaude ? "true" : "false"
          requestPayload.labels = {
            last_execution_id: lastExecutionId,
            last_step_index: String(requestStepIndex),
            model_enum: "MODEL_PLACEHOLDER_M132",
            trajectory_id: TRAJECTORY_ID,
            used_claude: claudeUsed,
            used_claude_conservative: claudeUsed,
          }
          lastExecutionId = crypto.randomUUID()

          // Tool config — only when function declarations are present
          if (Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
            requestPayload.toolConfig = {
              functionCallingConfig: { mode: "VALIDATED" },
            }
          }
        }
        const effectiveProjectId = projectId?.trim() || "";
        resolvedProjectId = effectiveProjectId;

        // System instruction injection removed — CLIProxyAPI v6.9.x no longer injects it
        const wrappedBody: Record<string, unknown> = {
          project: effectiveProjectId,
          model: toApiModelId(effectiveModel),
          request: requestPayload,
        };

        if (headerStyle === "antigravity") {
          wrappedBody.requestType = "agent";
          wrappedBody.userAgent = "antigravity";
          wrappedBody.requestId = buildAntigravityRequestId("agent");
        }
        if (wrappedBody.request && typeof wrappedBody.request === 'object') {
          // Use stable session ID for signature caching across multi-turn conversations
          sessionId = signatureSessionKey;
        }

        body = safeStringify(headerStyle === "antigravity" ? orderAntigravityEnvelope(wrappedBody) : wrappedBody);
      }
    } catch (err) {
      throw new Error("Failed to build Antigravity request body", { cause: err });
    }
  }
  if (headerStyle === "antigravity") {
    // Real Antigravity IDE content requests send ONLY these headers:
    //   Host, User-Agent, Authorization, Content-Type, Transfer-Encoding, Accept-Encoding
    // Host, Transfer-Encoding, and Accept-Encoding are auto-set by the fetch runtime.
    // Strip ALL inherited OpenCode/AI SDK headers (x-session-affinity, x-parent-session-id,
    // x-stainless-*, anthropic-version, Accept, etc.) to match real IDE signature exactly.
    // The streaming format is signaled by ?alt=sse in the URL, not by Accept header.
    const fingerprint = options?.fingerprint ?? getSessionFingerprint();
    const fingerprintHeaders = buildFingerprintHeaders(fingerprint);
    const selectedHeaders = getRandomizedHeaders("antigravity", requestedModel);
    const cleanUA = fingerprintHeaders["User-Agent"] || selectedHeaders["User-Agent"];
    const authValue = headers.get("Authorization");

    // Clear all inherited headers and rebuild with only real-IDE-matching set
    const keysToDelete: string[] = [];
    headers.forEach((_value, key) => { keysToDelete.push(key); });
    for (const key of keysToDelete) { headers.delete(key); }

    if (authValue) headers.set("Authorization", authValue);
    headers.set("Content-Type", "application/json");
    headers.set("User-Agent", cleanUA);
  } else {
    // Gemini CLI mode: match official google-gemini/gemini-cli User-Agent format
    // Accept: text/event-stream only for gemini-cli mode (antigravity uses ?alt=sse URL param)
    if (streaming) {
      headers.set("Accept", "text/event-stream");
    }
    const geminiCliHeaders = getRandomizedHeaders("gemini-cli", requestedModel);
    headers.set("User-Agent", geminiCliHeaders["User-Agent"]);
    if (geminiCliHeaders["X-Goog-Api-Client"]) headers.set("X-Goog-Api-Client", geminiCliHeaders["X-Goog-Api-Client"]);
    if (geminiCliHeaders["Client-Metadata"]) headers.set("Client-Metadata", geminiCliHeaders["Client-Metadata"]);
  }

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel,
    effectiveModel: effectiveModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    sessionId,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
    needsSignedThinkingWarmup,
    headerStyle,
    thinkingRecoveryMessage,
  };
}

export function buildThinkingWarmupBody(
  bodyText: string | undefined,
  isClaudeThinking: boolean,
): string | null {
  if (!bodyText || !isClaudeThinking) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const warmupPrompt = "Warmup request for thinking signature.";

  const updateRequest = (req: Record<string, unknown>) => {
    req.contents = [{ role: "user", parts: [{ text: warmupPrompt }] }];
    delete req.tools;
    delete (req as any).toolConfig;

    const generationConfig = (req.generationConfig ?? {}) as Record<string, unknown>;
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: DEFAULT_THINKING_BUDGET,
    };
    generationConfig.maxOutputTokens = computeClaudeMaxOutputTokens(DEFAULT_THINKING_BUDGET);
    req.generationConfig = generationConfig;  };

  if (parsed.request && typeof parsed.request === "object") {
    updateRequest(parsed.request as Record<string, unknown>);
    const nested = (parsed.request as any).request;
    if (nested && typeof nested === "object") {
      updateRequest(nested as Record<string, unknown>);
    }
  } else {
    updateRequest(parsed);
  }

  return safeStringify(parsed);
}
/**
 * Normalizes Antigravity responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 *
 * For streaming SSE responses, uses TransformStream for true real-time incremental streaming.
 * Thinking/reasoning tokens are transformed and forwarded immediately as they arrive.
 */
export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
  projectId?: string,
  endpoint?: string,
  effectiveModel?: string,
  sessionId?: string,
  toolDebugMissing?: number,
  toolDebugSummary?: string,
  toolDebugPayload?: string,
  debugLines?: string[],
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  // Generate text for thinking injection:
  // - If debug=true: inject full debug logs
  // - If keep_thinking=true (but no debug): inject placeholder to trigger signature caching
  // Both use the same injection path (injectDebugThinking) for consistent behavior
  const debugText =
    isDebugTuiEnabled() && Array.isArray(debugLines) && debugLines.length > 0
      ? formatDebugLinesForThinking(debugLines)
      : getKeepThinking()
        ? SYNTHETIC_THINKING_PLACEHOLDER
        : undefined;
  const cacheSignatures = shouldCacheThinkingSignatures(effectiveModel);

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  // For successful streaming responses, use TransformStream to transform SSE events
  // while maintaining real-time streaming (no buffering of entire response).
  // This enables thinking tokens to be displayed as they arrive, like the Codex plugin.
  if (streaming && response.ok && isEventStreamResponse && response.body) {
    const headers = new Headers(response.headers);

    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE response (real-time transform)",
    });

    const streamingTransformer = createStreamingTransformer(
      defaultSignatureStore,
      {
        onCacheSignature: cacheSignature,
        onInjectDebug: injectDebugThinking,
        onUsageMetadata: (usage) => {
          if (effectiveModel) {
            recordUsageStats(usage, effectiveModel)
          }
        },
        transformThinkingParts,
      },      {
        signatureSessionKey: sessionId,
        debugText,
        cacheSignatures,
        displayedThinkingHashes: effectiveModel && isGemini3Model(effectiveModel) ? sessionDisplayedThinkingHashes : undefined,
        // injectSyntheticThinking removed - keep_thinking now unified with debug via debugText
      },
    );
    return new Response(response.body.pipeThrough(streamingTransformer), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const responseFallback = response.clone();

  let pendingRecoveryThrow: Error | undefined

  try {
    const headers = new Headers(response.headers);
    const text = await response.text();

    if (!response.ok) {
      let errorBody;
      try {
        errorBody = JSON.parse(text);
      } catch {
        errorBody = { error: { message: text } };
      }

      // Inject Debug Info
      if (errorBody?.error) {
        const rawErrorMessage =
          typeof errorBody.error.message === "string" && errorBody.error.message.length > 0
            ? errorBody.error.message
            : "Unknown error";
        const errorType = detectErrorType(rawErrorMessage);
        const debugInfo = `\n\n[Debug Info]\nRequested Model: ${requestedModel || "Unknown"}\nEffective Model: ${effectiveModel || "Unknown"}\nProject: ${projectId || "Unknown"}\nEndpoint: ${endpoint || "Unknown"}\nStatus: ${response.status}\nRequest ID: ${headers.get("x-request-id") || "N/A"}${toolDebugMissing !== undefined ? `\nTool Debug Missing: ${toolDebugMissing}` : ""}${toolDebugSummary ? `\nTool Debug Summary: ${toolDebugSummary}` : ""}${toolDebugPayload ? `\nTool Debug Payload: ${toolDebugPayload}` : ""}`;
        const injectedDebug = debugText ? `\n\n${debugText}` : "";
        errorBody.error.message = rawErrorMessage + debugInfo + injectedDebug;

        // Check if this is a recoverable thinking error - signal via finally to propagate
        if (errorType === "thinking_block_order") {
          pendingRecoveryThrow = Object.assign(new Error("THINKING_RECOVERY_NEEDED"), {
            recoveryType: errorType,
            originalError: errorBody,
            debugInfo,
          })
          return new Response(JSON.stringify(errorBody), {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }

        // Detect context length / prompt too long errors - signal to caller for toast
        const errorMessage = errorBody.error.message?.toLowerCase() || "";
        if (
          errorMessage.includes("prompt is too long") ||
          errorMessage.includes("context length exceeded") ||
          errorMessage.includes("context_length_exceeded") ||
          errorMessage.includes("maximum context length")
        ) {
          headers.set("x-antigravity-context-error", "prompt_too_long");
        }

        // Detect tool pairing errors - signal to caller for toast
        if (
          errorMessage.includes("tool_use") &&
          errorMessage.includes("tool_result") &&
          (errorMessage.includes("without") || errorMessage.includes("immediately after"))
        ) {
          headers.set("x-antigravity-context-error", "tool_pairing");
        }

        return new Response(JSON.stringify(errorBody), {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }

      if (errorBody?.error?.details && Array.isArray(errorBody.error.details)) {
        const retryInfo = errorBody.error.details.find(
          (detail: any) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
        );

        if (retryInfo?.retryDelay) {
          const match = retryInfo.retryDelay.match(/^([\d.]+)s$/);
          if (match && match[1]) {
            const retrySeconds = parseFloat(match[1]);
            if (!isNaN(retrySeconds) && retrySeconds > 0) {
              const retryAfterSec = Math.ceil(retrySeconds).toString();
              const retryAfterMs = Math.ceil(retrySeconds * 1000).toString();
              headers.set('Retry-After', retryAfterSec);
              headers.set('retry-after-ms', retryAfterMs);
            }
          }
        }
      }
    }

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed: AntigravityApiBody | null = !streaming || !isEventStreamResponse ? parseAntigravityApiBody(text) : null;
    const patched = parsed ? rewriteAntigravityPreviewAccessError(parsed, response.status, requestedModel) : null;
    const effectiveBody = patched ?? parsed ?? undefined;

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    
    // Log cache stats when available
    if (usage && effectiveModel) {
      recordUsageStats(usage, effectiveModel)
    }
    if (usage?.cachedContentTokenCount !== undefined) {
      headers.set("x-antigravity-cached-content-token-count", String(usage.cachedContentTokenCount));
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-antigravity-total-token-count", String(usage.totalTokenCount));
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-antigravity-prompt-token-count", String(usage.promptTokenCount));
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-antigravity-candidates-token-count", String(usage.candidatesTokenCount));
      }
      if (usage.thoughtsTokenCount !== undefined && usage.thoughtsTokenCount > 0) {
        headers.set("x-antigravity-thoughts-token-count", String(usage.thoughtsTokenCount));
      }
    }

    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered fallback)" : undefined,
      headersOverride: headers,
    });

    // Note: successful streaming responses are handled above via TransformStream.
    // This path only handles non-streaming responses or failed streaming responses.

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
      let responseBody: unknown = effectiveBody.response;
      // Inject thinking text (debug logs or "[Thinking preserved]" placeholder)
      // Both debug=true and keep_thinking=true use the same path now
      if (debugText) {
        responseBody = injectDebugThinking(responseBody, debugText);
      }
      const transformed = transformThinkingParts(responseBody);
      return new Response(JSON.stringify(transformed), init);
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init);
    }

    return new Response(text, init);
  } catch (error) {
    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response",
    });
    return responseFallback;
  } finally {
    if (pendingRecoveryThrow) throw pendingRecoveryThrow
  }
}

export const __testExports = {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveConversationKey,
  resolveProjectKey,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasSignedThinkingInContents,
  hasSignedThinkingInMessages,
  hasToolUseInContents,
  hasToolUseInMessages,
  ensureThinkingBeforeToolUseInContents,
  ensureThinkingBeforeToolUseInMessages,
  MIN_SIGNATURE_LENGTH,
  transformSseLine,
  transformStreamingPayload,
  createStreamingTransformer,
};
