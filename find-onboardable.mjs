import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) anthropic-desktop/2.0.0 Chrome/134.0.6998.44 Electron/35.0.1"
const d = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "antigravity-accounts.json"), "utf8"))

async function tryOnboard(idx) {
  const acc = d.accounts[idx]
  if (!acc) return

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: acc.refreshToken, client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "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" }),
  })
  const tokenData = await tokenResp.json()
  const accessToken = tokenData.access_token
  if (!accessToken) { console.log(idx, acc.email, "TOKEN_FAIL"); return }

  const loadResp = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ requestSource: { platform: "WINDOWS" } }),
  })
  const loadData = await loadResp.json()
  if (loadData.error) { console.log(idx, acc.email, "LOAD_FAIL", loadData.error.code); return }
  const tierId = loadData?.allowedTiers?.[0]?.id || "free-tier"

  const onResp = await fetch("https://cloudcode-pa.googleapis.com/v1internal:onboardUser", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ tierId }),
  })
  const onData = await onResp.json()
  const projId = onData?.response?.cloudaicompanionProject?.id || onData?.cloudaicompanionProject?.id
  if (projId) { console.log(idx, acc.email, "OK", projId); return }
  if (onData?.name && !onData?.done) { console.log(idx, acc.email, "PENDING", onData.name); return }
  console.log(idx, acc.email, "FAIL", JSON.stringify(onData).substring(0, 120))
}

const indices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 25, 30, 40, 50]
for (const i of indices) {
  await tryOnboard(i)
}
