import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { rm } from "node:fs/promises"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { errorText, fetchWithRetry, readJson } from "./http.js"

const STORE_BASE = "https://appstore-us.picoxr.com"
const ITEM_ID = "7494362493653958711"
const PACKAGE_NAME = "com.valvesoftware.steamlinkvr"
const STORE_QUERY = {
  manifest_version_code: "400900006",
  device_name: "A9210",
  app_id: "314431",
  app_language: "en",
  client_type: "1",
  zone_name: "Asia/Shanghai",
}

function storeUrl(path, session) {
  const url = new URL(path, STORE_BASE)
  for (const [name, value] of Object.entries(STORE_QUERY)) {
    url.searchParams.set(name, value)
  }
  url.searchParams.set("uid", session.uid ?? "0")
  url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1_000)))
  return url
}

function storeHeaders(session) {
  const headers = {
    "Content-Type": "application/json",
    // the store app always sends an integer sdk-version, harmless with cookie-only auth
    "sdk-version": "2",
  }
  const cookies = Object.entries(session.cookies ?? {})
  if (cookies.length > 0) {
    headers.Cookie = cookies
      .map(([name, value]) => `${name}=${value}`)
      .join("; ")
  }
  return headers
}

export async function fetchDownloadInfo(session, { devPreview }) {
  const response = await fetchWithRetry(
    storeUrl("/api/app/v1/download/info", session),
    {
      method: "POST",
      headers: storeHeaders(session),
      // item_id exceeds Number.MAX_SAFE_INTEGER, so emit it as a raw json integer
      body: `{"item_id":${ITEM_ID},"package_name":${JSON.stringify(PACKAGE_NAME)},"incl_dev_preview":${devPreview}}`,
    },
  )
  const json = await readJson(response, "download/info")
  if (Number(json.code) !== 0) {
    const hint = [110001, 10006].includes(Number(json.code))
      ? " check PICO_EMAIL/PICO_PASSWORD and the account's PICO Store entitlement"
      : ""
    const detail = errorText(json.msg ?? json.message).trim()
    throw new Error(
      `store download/info failed (${json.code ?? "no code"}): ${detail}.${hint}`,
    )
  }

  const item = json.data
  const apk = item?.package
  if (!item || !apk)
    throw new Error("store download/info returned no package metadata")

  const version = String(apk.version ?? "")
  const versionCode = Number(apk.version_code)
  const md5 = String(apk.md5 ?? "").toLowerCase()
  if (!version || !Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error("store download/info returned an invalid version")
  }
  if (!/^[0-9a-f]{32}$/.test(md5)) {
    throw new Error("store download/info returned an invalid MD5")
  }
  if (typeof apk.path !== "string" || apk.path === "") {
    throw new Error("store download/info returned no download URL")
  }

  return { version, versionCode, md5, url: apk.path }
}

export async function downloadApk(url, destination, expectedMd5) {
  const response = await fetchWithRetry(url, {}, 2, 0)
  if (!response.ok || response.body === null) {
    throw new Error(`download failed (HTTP ${response.status})`)
  }

  const hash = createHash("md5")
  let bytes = 0
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      hasher,
      createWriteStream(destination),
    )
  } catch (error) {
    await rm(destination, { force: true })
    throw new Error(`download failed: ${error.message}`, { cause: error })
  }

  const actualMd5 = hash.digest("hex")
  if (actualMd5 !== expectedMd5) {
    await rm(destination, { force: true })
    throw new Error(
      `checksum mismatch: expected ${expectedMd5}, got ${actualMd5}`,
    )
  }
  return { bytes, md5: actualMd5 }
}
