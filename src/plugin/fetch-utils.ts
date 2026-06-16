/**
 * Default timeout for fetch requests in milliseconds.
 */
export const FETCH_TIMEOUT_MS = 10000

/**
 * Fetch with an AbortController timeout.
 * Automatically aborts the request if it takes longer than timeoutMs.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}
