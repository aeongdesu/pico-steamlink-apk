import { errorText, fetchOnce, fetchWithRetry, readJson } from "./http.js"

const PASSPORT_BASE = "https://matrix-us.picovr.com"
const PASSPORT_AID = "308733"
const AUTH_QUERY = {
  multi_login: "1",
  account_sdk_source: "app",
  "passport-sdk-version": "30490",
  aid: PASSPORT_AID,
  device_platform: "android",
}

// passport expects credentials XORed with 0x05 and hex-encoded.
export function encodePassportValue(value) {
  const bytes = Buffer.from(value, "utf8")
  let encoded = ""
  for (const byte of bytes) {
    encoded += (byte ^ 0x05).toString(16).padStart(2, "0")
  }
  return encoded
}

function cookieHeader(session) {
  const pairs = Object.entries(session.cookies ?? {})
  return pairs.length === 0
    ? {}
    : { Cookie: pairs.map(([name, value]) => `${name}=${value}`).join("; ") }
}

function cookiePairs(response) {
  const cookies = {}
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0]
    const separator = pair.indexOf("=")
    if (separator > 0) {
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (name && value) cookies[name] = value
    }
  }
  return cookies
}

function passportError(action, json) {
  const code = json.error_code ?? json.data?.error_code
  const detail = json.description ?? json.message ?? "unknown error"
  return new Error(
    `${action} failed (${code ?? "no code"}): ${errorText(detail)}`,
  )
}

function assertSuccess(action, json) {
  const code = json.error_code ?? json.data?.error_code
  if (json.message === "success" && (code === undefined || Number(code) === 0))
    return
  throw passportError(action, json)
}

function authUrl(path) {
  const url = new URL(path, PASSPORT_BASE)
  for (const [name, value] of Object.entries(AUTH_QUERY)) {
    url.searchParams.set(name, value)
  }
  return url
}

function formBody(fields) {
  return new URLSearchParams(fields).toString()
}

export class SessionExpiredError extends Error {
  constructor(message) {
    super(message)
    this.name = "SessionExpiredError"
  }
}

function sessionExpired() {
  return new SessionExpiredError(
    "session is not authenticated. check PICO_EMAIL and PICO_PASSWORD.",
  )
}

export async function loginWithPassword(email, password) {
  const response = await fetchOnce(authUrl("/passport/user/login/"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      mix_mode: "1",
      email: encodePassportValue(email),
      password: encodePassportValue(password),
    }),
  })
  const json = await readJson(response, "password login")
  if (Number(json.error_code ?? json.data?.error_code) === 1009) {
    throw new Error(
      "password login failed (1009): email or password is incorrect. " +
        "if this account was created with email-code login, set a password first",
    )
  }
  assertSuccess("password login", json)

  const cookies = cookiePairs(response)
  if (Object.keys(cookies).length === 0) {
    throw new Error("password login succeeded but returned no session cookies.")
  }
  const uid = json.data?.user_id_str ?? json.data?.user_id
  // password login is cookie-only, not returns X-Tt-Token (email code only?)
  return {
    cookies,
    uid: uid === undefined ? undefined : String(uid),
  }
}

export async function fetchAccount(session) {
  const url = new URL("/passport/account/info/v2/", PASSPORT_BASE)
  url.searchParams.set("aid", PASSPORT_AID)
  url.searchParams.set("device_platform", "android")
  url.searchParams.set("passport-sdk-version", "30490")
  const response = await fetchWithRetry(url, { headers: cookieHeader(session) })
  let json
  try {
    json = await readJson(response, "account info")
  } catch (error) {
    if (response.status === 401) throw sessionExpired()
    throw error
  }
  if (response.status === 401) throw sessionExpired()
  if (json.message !== "success" || json.data === undefined) {
    if (Number(json.error_code) === 13) throw sessionExpired()
    throw passportError("account info", json)
  }
  const uid = json.data.user_id_str ?? json.data.user_id
  if (uid === undefined || uid === null || uid === "") {
    throw new Error("account info did not return a user id")
  }
  return { uid: String(uid) }
}
