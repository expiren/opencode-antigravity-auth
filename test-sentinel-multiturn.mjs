import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const ACCOUNT_INDEX = parseInt(process.env.ACCOUNT_INDEX || "10", 10)
const data = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "antigravity-accounts.json"), "utf8"))
const acc = data.accounts[ACCOUNT_INDEX]
console.log(`Using account[${ACCOUNT_INDEX}]: ${acc.email}`)

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
  console.log("Token refreshed OK")
  return payload.access_token
}

async function sendRequest(accessToken, projectId, endpoint, contents, model) {
  const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`
  const body = {
    project: projectId,
    model,
    request: {
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 100 },
    },
  }

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
    let msg = text.substring(0, 300)
    try {
      const parsed = JSON.parse(text)
      msg = parsed?.error?.message || msg
    } catch {
      const dataLine = text.split("\n").find(l => l.startsWith("data:"))
      if (dataLine) {
        try { msg = JSON.parse(dataLine.slice(5).trim())?.error?.message || msg } catch {}
      }
    }
    return { ok: false, status: resp.status, error: msg }
  }

  // Extract response text from SSE chunks
  let responseText = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    try {
      const chunk = JSON.parse(line.slice(5).trim())
      const parts = chunk?.candidates?.[0]?.content?.parts || []
      for (const p of parts) {
        if (p.text && !p.thought) responseText += p.text
      }
    } catch {}
  }
  return { ok: true, status: 200, text: responseText.trim() }
}

async function multiTurnTest(accessToken, projectId, endpoint, testName, sentinelValue, model, turns) {
  console.log(`\n${"=".repeat(60)}`)
  console.log(`TEST: "${testName}" | sentinel: ${JSON.stringify(sentinelValue)} | model: ${model}`)
  console.log(`${"=".repeat(60)}`)

  const contents = []
  const questions = [
    "What is 2+2? Answer with just the number.",
    "What is 3+3? Answer with just the number.",
    "What is 4+4? Answer with just the number.",
    "What is 5+5? Answer with just the number.",
    "What is 6+6? Answer with just the number.",
    "What is 7+7? Answer with just the number.",
    "What is 8+8? Answer with just the number.",
    "What is 9+9? Answer with just the number.",
  ]

  for (let turn = 0; turn < turns; turn++) {
    const q = questions[turn % questions.length]
    contents.push({ role: "user", parts: [{ text: q }] })

    const result = await sendRequest(accessToken, projectId, endpoint, contents, model)

    if (!result.ok) {
      console.log(`  Turn ${turn + 1}: ❌ FAIL status=${result.status} — ${result.error.substring(0, 200)}`)
      console.log(`  STOPPED at turn ${turn + 1}/${turns} — sentinel ${JSON.stringify(sentinelValue)} FAILS on multi-turn`)
      return false
    }

    console.log(`  Turn ${turn + 1}: ✅ 200 OK — "${result.text.substring(0, 60)}" (${contents.length} messages, ${turn + 1} sentinels in history)`)

    // Add model response WITH sentinel (simulating stripped thinking block)
    const modelParts = []
    if (sentinelValue !== null) {
      modelParts.push({ text: sentinelValue })  // sentinel replacing a thinking block
    }
    modelParts.push({ text: result.text || "OK" })
    contents.push({ role: "model", parts: modelParts })
  }

  console.log(`  ✅ ALL ${turns} TURNS PASSED with sentinel ${JSON.stringify(sentinelValue)}`)
  return true
}

async function onboardAccount(accessToken) {
  // Step 1: loadCodeAssist to get tierId
  const loadResp = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
      "User-Agent": ANTIGRAVITY_UA,
    },
    body: JSON.stringify({ requestSource: { platform: "WINDOWS" } }),
  })
  const loadData = await loadResp.json()
  const tierId = loadData?.allowedTiers?.[0]?.id || "free-tier"

  // Step 2: onboardUser
  let projectId = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const onboardResp = await fetch("https://cloudcode-pa.googleapis.com/v1internal:onboardUser", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
        "User-Agent": ANTIGRAVITY_UA,
      },
      body: JSON.stringify({ tierId }),
    })
    const onboardData = await onboardResp.json()
    console.log(`  onboard attempt ${attempt}: ${JSON.stringify(onboardData).substring(0, 200)}`)
    if (onboardData?.done && onboardData?.response?.cloudaicompanionProject?.id) {
      projectId = onboardData.response.cloudaicompanionProject.id
      break
    }
    // Also check nested response format
    const projId = onboardData?.response?.cloudaicompanionProject?.id
      || onboardData?.cloudaicompanionProject?.id
    if (projId) { projectId = projId; break }
    await new Promise(r => setTimeout(r, 2000))
  }

  if (!projectId) throw new Error("Failed to onboard account after 5 attempts")
  return projectId
}

async function main() {
  const token = await refreshToken()

  let projectId = process.env.PROJECT_ID
  if (!projectId) {
    console.log("Onboarding account to get project ID...")
    projectId = await onboardAccount(token)
  }
  console.log(`Project ID: ${projectId}`)

  const endpoint = "https://daily-cloudcode-pa.sandbox.googleapis.com"
  const model = "claude-opus-4-6-thinking"
  const TURNS = 5

  console.log(`\nMulti-turn sentinel test: ${TURNS} turns each`)
  console.log(`Model: ${model}`)
  console.log(`Endpoint: ${endpoint}\n`)

  // Test 1: dot sentinel (our current Claude approach)
  await multiTurnTest(token, projectId, endpoint, "dot", ".", model, TURNS)

  // Test 2: space sentinel (antigravity2api-nodejs approach)
  await multiTurnTest(token, projectId, endpoint, "space", " ", model, TURNS)

  // Test 3: no sentinel (filter approach — other SDKs)
  await multiTurnTest(token, projectId, endpoint, "no-sentinel (filter)", null, model, TURNS)

  // Test 4: empty string (KNOWN BROKEN — verification)
  await multiTurnTest(token, projectId, endpoint, "empty-string", "", model, TURNS)

  // Test 5: zero-width space
  await multiTurnTest(token, projectId, endpoint, "zwsp", "\u200B", model, TURNS)

  console.log("\n" + "=".repeat(60))
  console.log("ALL TESTS COMPLETE")
  console.log("=".repeat(60))
}

main().catch(e => console.error(e))
