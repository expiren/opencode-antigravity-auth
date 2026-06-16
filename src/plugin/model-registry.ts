import type { ProviderModel } from "./types"
import type { ThinkingTier } from "./transform/types"

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high"

export interface ModelThinkingConfig {
  thinkingBudget: number
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel
  thinkingConfig?: ModelThinkingConfig
}

export interface ModelLimit {
  context: number
  output: number
}

export type ModelModality = "text" | "image" | "pdf"
export type ModelQuotaGroup = "claude" | "gemini-pro" | "gemini-flash" | "gpt-oss"

export interface ModelModalities {
  input: ModelModality[]
  output: ModelModality[]
}

export interface OpencodeModelDefinition extends ProviderModel {
  id: string
  name: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  limit: ModelLimit
  modalities: ModelModalities
  cost: {
    input: number
    output: number
  }
  options: Record<string, unknown>
  variants?: Record<string, ModelVariant>
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>

interface OpencodeModelDefinitionInput {
  name: string
  reasoning: boolean
  limit: ModelLimit
  modalities: ModelModalities
  variants?: Record<string, ModelVariant>
}

interface GeminiRouteMetadata {
  antigravity: {
    defaultModel: string
    byTier: Partial<Record<ThinkingTier, string>>
  }
  geminiCliFallbackModel: string
}

const DEFAULT_MODALITIES: ModelModalities = {
  input: ["text", "image", "pdf"],
  output: ["text"],
}

const MODEL_RELEASE_DATE = ""
const DEFAULT_COST = { input: 0, output: 0 }
const DEFAULT_OPTIONS: Record<string, unknown> = {}

function defineModel(
  id: string,
  model: OpencodeModelDefinitionInput,
): OpencodeModelDefinition {
  return {
    id,
    release_date: MODEL_RELEASE_DATE,
    attachment: model.modalities.input.some((modality) => modality !== "text"),
    temperature: true,
    tool_call: true,
    cost: { ...DEFAULT_COST },
    options: { ...DEFAULT_OPTIONS },
    ...model,
  }
}

const PUBLIC_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  "antigravity-gemini-3.1-pro": defineModel("antigravity-gemini-3.1-pro", {
    name: "Gemini 3.1 Pro (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    },
  }),
  "antigravity-gemini-3.5-flash": defineModel("antigravity-gemini-3.5-flash", {
    name: "Gemini 3.5 Flash (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  }),
  "antigravity-claude-sonnet-4-6-thinking": defineModel("antigravity-claude-sonnet-4-6-thinking", {
    name: "Claude Sonnet 4.6 Thinking (Antigravity)",
    reasoning: true,
    limit: { context: 250000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  }),
  "antigravity-claude-opus-4-6-thinking": defineModel("antigravity-claude-opus-4-6-thinking", {
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    reasoning: true,
    limit: { context: 250000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  }),
  "antigravity-gemini-3.1-flash-image": defineModel("antigravity-gemini-3.1-flash-image", {
    name: "Gemini 3.1 Flash Image (Antigravity)",
    reasoning: false,
    limit: { context: 66000, output: 33000 },
    modalities: {
      input: ["text", "image"],
      output: ["text", "image"],
    },
  }),
  "antigravity-gpt-oss-120b": defineModel("antigravity-gpt-oss-120b", {
    name: "GPT-OSS 120B (Antigravity)",
    reasoning: true,
    limit: { context: 131072, output: 32768 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      medium: {},
    },
  }),
  "gemini-2.5-flash": defineModel("gemini-2.5-flash", {
    name: "Gemini 2.5 Flash (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-2.5-pro": defineModel("gemini-2.5-pro", {
    name: "Gemini 2.5 Pro (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-3-flash-preview": defineModel("gemini-3-flash-preview", {
    name: "Gemini 3 Flash Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-3.1-pro-preview": defineModel("gemini-3.1-pro-preview", {
    name: "Gemini 3.1 Pro Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-3.5-flash-preview": defineModel("gemini-3.5-flash-preview", {
    name: "Gemini 3.5 Flash Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  "gemini-3.1-flash-image": defineModel("gemini-3.1-flash-image", {
    name: "Gemini 3.1 Flash Image (Gemini CLI)",
    reasoning: false,
    limit: { context: 66000, output: 33000 },
    modalities: {
      input: ["text", "image"],
      output: ["text", "image"],
    },
  }),
  "gemini-3.1-flash-image-preview": defineModel("gemini-3.1-flash-image-preview", {
    name: "Gemini 3.1 Flash Image Preview (Gemini CLI)",
    reasoning: false,
    limit: { context: 66000, output: 33000 },
    modalities: {
      input: ["text", "image"],
      output: ["text", "image"],
    },
  }),
  "gemini-3.1-pro-preview-customtools": defineModel("gemini-3.1-pro-preview-customtools", {
    name: "Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  }),
}

const RESOLVER_ALIASES: Record<string, string> = {
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3-flash-low": "gemini-3-flash",
  "gemini-3-flash-medium": "gemini-3-flash",
  "gemini-3-flash-high": "gemini-3-flash",
  "gemini-3.5-flash-low": "gemini-3.5-flash",
  "gemini-3.5-flash-medium": "gemini-3.5-flash",
  "gemini-3.5-flash-high": "gemini-3.5-flash",
  "gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
  "gemini-claude-sonnet-4-6-thinking-low": "claude-sonnet-4-6-thinking",
  "gemini-claude-sonnet-4-6-thinking-medium": "claude-sonnet-4-6-thinking",
  "gemini-claude-sonnet-4-6-thinking-high": "claude-sonnet-4-6-thinking",
  "gemini-claude-sonnet-4-6": "claude-sonnet-4-6-thinking",
}

const GEMINI_35_FLASH_ROUTES: GeminiRouteMetadata = {
  antigravity: {
    defaultModel: "gemini-3-flash-agent",
    byTier: {
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
    },
  },
  geminiCliFallbackModel: "gemini-3-flash-preview",
}

const GEMINI_31_PRO_ROUTES: GeminiRouteMetadata = {
  antigravity: {
    defaultModel: "gemini-3.1-pro-low",
    byTier: {
      low: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
    },
  },
  geminiCliFallbackModel: "gemini-3.1-pro-preview",
}

const QUOTA_GROUP_BY_MODEL_ID: Record<string, ModelQuotaGroup> = {
  "claude-opus-4-6-thinking": "claude",
  "claude-opus-4-6": "claude",
  "claude-sonnet-4-6-thinking": "claude",
  "claude-sonnet-4-6": "claude",
  "gemini-pro-agent": "gemini-pro",
  "gemini-3.1-pro": "gemini-pro",
  "gemini-3.1-pro-low": "gemini-pro",
  "gemini-3-flash": "gemini-flash",
  "gemini-3-flash-agent": "gemini-flash",
  "gemini-3.5-flash-low": "gemini-flash",
  "gemini-3.1-flash-image": "gemini-flash",
  "gpt-oss-120b": "gpt-oss",
  "gpt-oss-120b-medium": "gpt-oss",
  "gemini-3.5-flash-extra-low": "gemini-flash",
  "gemini-2.5-flash-lite": "gemini-flash",
  "gemini-2.5-flash-thinking": "gemini-flash",
  "gemini-3.1-flash-lite": "gemini-flash",
  "gemini-2.5-pro": "gemini-pro",
}

export const OPENCODE_MODEL_DEFINITIONS = PUBLIC_MODEL_DEFINITIONS
export const MODEL_ALIASES = RESOLVER_ALIASES

export function getPublicModelDefinitions(): OpencodeModelDefinitions {
  return PUBLIC_MODEL_DEFINITIONS
}

export function getResolverAliasMap(): Record<string, string> {
  return RESOLVER_ALIASES
}

function resolveAntigravityRoute(routes: { antigravity: { defaultModel: string; byTier: Record<string, string> } }, tier?: ThinkingTier): string {
  if (!tier) return routes.antigravity.defaultModel
  return routes.antigravity.byTier[tier] ?? routes.antigravity.defaultModel
}

export function getGemini35FlashAntigravityModel(tier?: ThinkingTier): string {
  return resolveAntigravityRoute(GEMINI_35_FLASH_ROUTES, tier)
}

export function getGemini35FlashGeminiCliFallbackModel(): string {
  return GEMINI_35_FLASH_ROUTES.geminiCliFallbackModel
}

export function getGemini31ProAntigravityModel(tier?: ThinkingTier): string {
  return resolveAntigravityRoute(GEMINI_31_PRO_ROUTES, tier)
}

export function getQuotaGroupForModel(modelId: string): ModelQuotaGroup | undefined {
  return QUOTA_GROUP_BY_MODEL_ID[modelId.toLowerCase()]
}
