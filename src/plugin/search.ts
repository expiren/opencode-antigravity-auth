/**
 * Google Search Tool Implementation
 *
 * Due to Gemini API limitations, native search tools (googleSearch, urlContext)
 * cannot be combined with function declarations. This module implements a
 * wrapper that makes separate API calls with only the grounding tools enabled.
 */

import crypto from "node:crypto"

import {
  ANTIGRAVITY_ENDPOINT,
  getContentRequestUserAgent,
  SEARCH_MODEL,
  SEARCH_TIMEOUT_MS,
  SEARCH_SYSTEM_INSTRUCTION,
} from "../constants";
import { createLogger } from "./logger";

const log = createLogger("search");

// ============================================================================
// Types
// ============================================================================

interface GroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}

interface GroundingSupport {
  segment?: {
    startIndex?: number;
    endIndex?: number;
    text?: string;
  };
  groundingChunkIndices?: number[];
}

interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
  searchEntryPoint?: {
    renderedContent?: string;
  };
}

interface UrlMetadata {
  retrieved_url?: string;
  url_retrieval_status?: string;
}

interface UrlContextMetadata {
  url_metadata?: UrlMetadata[];
}

interface SearchResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
    groundingMetadata?: GroundingMetadata;
    urlContextMetadata?: UrlContextMetadata;
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface AntigravitySearchResponse {
  response?: SearchResponse;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export interface SearchArgs {
  query: string;
  urls?: string[];
  thinking?: boolean;
}

export interface SearchResult {
  text: string;
  sources: Array<{ title: string; url: string }>;
  searchQueries: string[];
  urlsRetrieved: Array<{ url: string; status: string }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

const SEARCH_CONVERSATION_ID = crypto.randomUUID();
const SEARCH_TRAJECTORY_ID = crypto.randomUUID();
let searchStepIndex = 0;
// Deterministic session ID from workspace directory (FNV-1a 64-bit hash)
// Shares the same hash algorithm as request.ts — initialized via initSearchSessionId()
let SEARCH_NUMERIC_SESSION_ID = "-3750763034362895579" // FNV-1a("") default

export function initSearchSessionId(directory: string): void {
  const FNV1A_64_OFFSET_BASIS = 0xCBF29CE484222325n
  const FNV1A_64_PRIME = 0x00000100000001B3n
  let hash = FNV1A_64_OFFSET_BASIS
  const bytes = Buffer.from(directory, "utf-8")
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME)
  }
  const signed = hash > 0x7FFFFFFFFFFFFFFFn
    ? hash - 0x10000000000000000n
    : hash
  SEARCH_NUMERIC_SESSION_ID = signed.toString()
}

function generateRequestId(): string {
  const timestamp = Date.now().toString();
  return `agent/${SEARCH_CONVERSATION_ID}/${timestamp}/${SEARCH_TRAJECTORY_ID}/${searchStepIndex++}`;
}

function formatSearchResult(result: SearchResult): string {
  const lines: string[] = [];

  lines.push("## Search Results\n");
  lines.push(result.text);
  lines.push("");

  if (result.sources.length > 0) {
    lines.push("### Sources");
    for (const source of result.sources) {
      lines.push(`- [${source.title}](${source.url})`);
    }
    lines.push("");
  }

  if (result.urlsRetrieved.length > 0) {
    lines.push("### URLs Retrieved");
    for (const url of result.urlsRetrieved) {
      const status = url.status === "URL_RETRIEVAL_STATUS_SUCCESS" ? "✓" : "✗";
      lines.push(`- ${status} ${url.url}`);
    }
    lines.push("");
  }

  if (result.searchQueries.length > 0) {
    lines.push("### Search Queries Used");
    for (const q of result.searchQueries) {
      lines.push(`- "${q}"`);
    }
  }

  return lines.join("\n");
}

function parseSearchResponse(data: AntigravitySearchResponse): SearchResult {
  const result: SearchResult = {
    text: "",
    sources: [],
    searchQueries: [],
    urlsRetrieved: [],
  };

  const response = data.response;
  if (!response || !response.candidates || response.candidates.length === 0) {
    if (data.error) {
      result.text = `Error: ${data.error.message ?? "Unknown error"}`;
    } else if (response?.error) {
      result.text = `Error: ${response.error.message ?? "Unknown error"}`;
    }
    return result;
  }

  const candidate = response.candidates[0];
  if (!candidate) {
    return result;
  }

  // Extract text content
  if (candidate.content?.parts) {
    result.text = candidate.content.parts
      .map((p: { text?: string }) => p.text ?? "")
      .filter(Boolean)
      .join("\n");
  }

  // Extract grounding metadata
  if (candidate.groundingMetadata) {
    const groundingMeta = candidate.groundingMetadata;

    if (groundingMeta.webSearchQueries) {
      result.searchQueries = groundingMeta.webSearchQueries;
    }

    if (groundingMeta.groundingChunks) {
      for (const chunk of groundingMeta.groundingChunks) {
        if (chunk.web?.uri && chunk.web?.title) {
          result.sources.push({
            title: chunk.web.title,
            url: chunk.web.uri,
          });
        }
      }
    }
  }

  // Extract URL context metadata
  if (candidate.urlContextMetadata?.url_metadata) {
    for (const meta of candidate.urlContextMetadata.url_metadata) {
      if (meta.retrieved_url) {
        result.urlsRetrieved.push({
          url: meta.retrieved_url,
          status: meta.url_retrieval_status ?? "UNKNOWN",
        });
      }
    }
  }

  return result;
}

// ============================================================================
// Main Search Function
// ============================================================================

/**
 * Execute a Google Search using the Gemini grounding API.
 *
 * This makes a SEPARATE API call with only googleSearch/urlContext tools,
 * which is required because these tools cannot be combined with function declarations.
 */
export async function executeSearch(
  args: SearchArgs,
  accessToken: string,
  projectId: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const { query, urls, thinking = true } = args;

  // Build prompt with optional URLs
  let prompt = query;
  if (urls && urls.length > 0) {
    const urlList = urls.join("\n");
    prompt = `${query}\n\nURLs to analyze:\n${urlList}`;
  }

  // Build tools array - only grounding tools, no function declarations
  const tools: Array<Record<string, unknown>> = [];
  tools.push({ googleSearch: {} });
  if (urls && urls.length > 0) {
    tools.push({ urlContext: {} });
  }

  const requestPayload = {
    systemInstruction: {
      parts: [{ text: SEARCH_SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    tools,
  };

  // Wrap in Antigravity format
  const wrappedBody = {
    project: projectId,
    model: SEARCH_MODEL,
    userAgent: "antigravity",
    requestId: generateRequestId(),
    requestType: "agent",
    request: {
      ...requestPayload,
      sessionId: SEARCH_NUMERIC_SESSION_ID,
      generationConfig: {
        temperature: 0,
        topP: 1,
      },
    },
  };
  // Use non-streaming endpoint for search
  const url = `${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`;

  log.debug("Executing search", {
    query,
    urlCount: urls?.length ?? 0,
    thinking,
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": getContentRequestUserAgent(),
      },
      body: JSON.stringify(wrappedBody),
      signal: abortSignal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.debug("Search API error", { status: response.status, error: errorText });
      return `## Search Error\n\nFailed to execute search: ${response.status} ${response.statusText}\n\n${errorText}\n\nPlease try again with a different query.`;
    }

    const data = (await response.json()) as AntigravitySearchResponse;
    log.debug("Search response received", { hasResponse: !!data.response });

    const result = parseSearchResponse(data);
    const formatted = formatSearchResult(result);
    log.debug("Search response formatted", { resultLength: formatted.length });
    return formatted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.debug("Search execution error", { error: message });
    return `## Search Error\n\nFailed to execute search: ${message}. Please try again with a different query.`;
  }
}
