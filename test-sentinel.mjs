import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const data = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "antigravity-accounts.json"), "utf8"))
const acc = data.accounts[5]

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLIENT_SECRET = "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"

const ANTIGRAVITY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36"
const CLIENT_METADATA = `{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}`

async function refreshToken() {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: acc.refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  })
  if (!resp.ok) {
    console.log("Token refresh failed:", resp.status, await resp.text())
    process.exit(1)
  }
  const payload = await resp.json()
  console.log("Token refreshed OK, expires_in:", payload.expires_in)
  return payload.access_token
}

async function onboardAndGetProject(accessToken) {
  const endpoints = [
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]
  
  for (const base of endpoints) {
    try {
      // loadCodeAssist — omit platform to avoid enum validation error
      const loadResp = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": ANTIGRAVITY_UA,
          "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
          "Client-Metadata": CLIENT_METADATA,
        },
        body: JSON.stringify({
          metadata: { ideType: "ANTIGRAVITY", pluginType: "GEMINI" },
        }),
      })
      if (loadResp.ok) {
        const result = await loadResp.json()
        console.log("loadCodeAssist raw:", JSON.stringify(result).substring(0, 300))
        const proj = typeof result.cloudaicompanionProject === "string"
          ? result.cloudaicompanionProject
          : result.cloudaicompanionProject?.id
        if (proj) {
          console.log(`Project from loadCodeAssist (${base}):`, proj)
          return { projectId: proj, endpoint: base }
        }
        const tierId = result.currentTier?.id || result.allowedTiers?.[0]?.id
        if (tierId) {
          console.log(`Got tierId=${tierId}, onboarding...`)
          for (let attempt = 0; attempt < 5; attempt++) {
            const onResp = await fetch(`${base}/v1internal:onboardUser`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
                "User-Agent": ANTIGRAVITY_UA,
                "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
                "Client-Metadata": CLIENT_METADATA,
              },
              body: JSON.stringify({ tierId, metadata: { ideType: "ANTIGRAVITY", pluginType: "GEMINI" } }),
            })
            if (!onResp.ok) {
              console.log(`onboardUser ${onResp.status}`)
              break
            }
            const onResult = await onResp.json()
            console.log(`onboardUser attempt ${attempt}:`, JSON.stringify(onResult).substring(0, 200))
            const managedId = onResult.response?.cloudaicompanionProject?.id
            if (onResult.done && managedId) {
              return { projectId: managedId, endpoint: base }
            }
            if (onResult.done) break
            await new Promise(r => setTimeout(r, 3000))
          }
        }
      } else {
        const txt = await loadResp.text().catch(() => "")
        console.log(`loadCodeAssist ${loadResp.status} at ${base}: ${txt.substring(0, 120)}`)
      }
    } catch (e) {
      console.log(`Error at ${base}:`, e.message)
    }
  }
  return null
}

async function testSentinel(accessToken, projectId, endpoint, testName, historicalParts, modelOverride) {
  const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`
  const model = modelOverride || "claude-sonnet-4-6-thinking"
  const body = {
    project: projectId,
    model,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: "agent-" + crypto.randomUUID(),
    request: {
      contents: [
        { role: "user", parts: [{ text: "Say hello in one sentence" }] },
        { role: "model", parts: historicalParts },
        { role: "user", parts: [{ text: "Thanks, say goodbye in one word" }] },
      ],
      generationConfig: { temperature: 0.5, maxOutputTokens: 50 },
    },
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": ANTIGRAVITY_UA,
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata": CLIENT_METADATA,
        "X-Device-Id": acc.fingerprint?.deviceId || "",
        "X-Session-Token": acc.fingerprint?.sessionToken || "",
      },
      body: JSON.stringify(body),
    })

    const text = await resp.text()
    if (resp.status !== 200) {
      // Try JSON error format
      try {
        const parsed = JSON.parse(text)
        console.log(`[${testName}] status=${resp.status} FAIL: ${(parsed?.error?.message || JSON.stringify(parsed)).substring(0, 300)}`)
        return
      } catch {}
      // Try SSE error format
      const dataLine = text.split("\n").find(l => l.startsWith("data:"))
      if (dataLine) {
        try {
          const errData = JSON.parse(dataLine.slice(5).trim())
          console.log(`[${testName}] status=${resp.status} FAIL (SSE): ${(errData?.error?.message || JSON.stringify(errData)).substring(0, 300)}`)
          return
        } catch {}
      }
      console.log(`[${testName}] status=${resp.status} FAIL: ${text.substring(0, 300)}`)
    } else {
      const dataLines = text.split("\n").filter(l => l.startsWith("data:"))
      console.log(`[${testName}] status=200 OK (${dataLines.length} SSE chunks)`)
    }
  } catch (e) {
    console.log(`[${testName}] ERROR: ${e.message}`)
  }
}

async function main() {
  const token = await refreshToken()
  
  // Onboard this account to get its project ID
  const result = await onboardAndGetProject(token)
  if (!result) {
    console.log("Failed to get project for this account")
    process.exit(1)
  }
  const { projectId } = result
  const endpoint = "https://daily-cloudcode-pa.sandbox.googleapis.com"
  console.log(`Endpoint: ${endpoint}\nProject: ${projectId}`)
  console.log("\n========== SENTINEL TESTS (claude-opus-4-6-thinking) ==========\n")

  const model = "claude-opus-4-6-thinking"

  const tests = [
    ["dot", [{ text: "." }, { text: "Hello! How can I help?" }]],
    ["empty-string", [{ text: "" }, { text: "Hello! How can I help?" }]],
    ["space", [{ text: " " }, { text: "Hello! How can I help?" }]],
    ["empty-obj", [{}, { text: "Hello! How can I help?" }]],
    ["thought-empty", [{ thought: true, text: "" }, { text: "Hello! How can I help?" }]],
    ["thought-dot", [{ thought: true, text: "." }, { text: "Hello! How can I help?" }]],
    ["no-sentinel", [{ text: "Hello! How can I help?" }]],
    ["null-text", [{ text: null }, { text: "Hello! How can I help?" }]],
    ["newline", [{ text: "\n" }, { text: "Hello! How can I help?" }]],
    ["zwsp", [{ text: "\u200B" }, { text: "Hello! How can I help?" }]],
  ]

  for (const [name, parts] of tests) {
    await testSentinel(token, projectId, endpoint, name, parts, model)
  }

  console.log("\n========== DONE ==========")
}

main().catch(e => console.error(e))
