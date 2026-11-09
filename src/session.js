import * as core from "@actions/core"
import { getOctokit } from "@actions/github"
import sodium from "libsodium-wrappers"
import {
  fetchAccount,
  loginWithPassword,
  SessionExpiredError,
} from "./passport.js"

const SESSION_SECRET_NAME = "PICO_SESSION"

export function parseStoredSession(raw) {
  if (!raw?.trim()) return undefined
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined
  }
  const cookies = {}
  for (const [name, value] of Object.entries(data.cookies ?? {})) {
    if (typeof value === "string" && value) cookies[name] = value
  }
  if (Object.keys(cookies).length === 0) return undefined
  return {
    cookies,
    uid: data.uid === undefined ? undefined : String(data.uid),
  }
}

async function saveSession(session, pat) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error("missing GITHUB_REPOSITORY")

  const [owner, repo] = repository.split("/")
  if (!owner || !repo) {
    throw new Error(`invalid GITHUB_REPOSITORY: ${repository}`)
  }

  const options = process.env.GITHUB_API_URL
    ? { baseUrl: process.env.GITHUB_API_URL }
    : {}
  const octokit = getOctokit(pat, options)
  try {
    const { data: key } = await octokit.rest.actions.getRepoPublicKey({
      owner,
      repo,
    })

    // the secret value must be sealed with the repository's public key
    await sodium.ready
    const encrypted = sodium.crypto_box_seal(
      sodium.from_string(JSON.stringify(session)),
      sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
    )
    await octokit.rest.actions.createOrUpdateRepoSecret({
      owner,
      repo,
      secret_name: SESSION_SECRET_NAME,
      encrypted_value: sodium.to_base64(
        encrypted,
        sodium.base64_variants.ORIGINAL,
      ),
      key_id: key.key_id,
    })
  } catch (error) {
    throw new Error(`failed to save PICO_SESSION: ${error.message}`, {
      cause: error,
    })
  }
}

export async function resolveSession() {
  const email = process.env.PICO_EMAIL?.trim()
  const password = process.env.PICO_PASSWORD?.replace(/\r$/, "")
  if (!email || !password) {
    throw new Error("missing PICO_EMAIL or PICO_PASSWORD repository secret")
  }

  const raw = process.env.PICO_SESSION
  const stored = parseStoredSession(raw)
  if (raw?.trim() && !stored) {
    core.warning("ignoring invalid PICO_SESSION; logging in again.")
  }

  if (stored) {
    try {
      const { uid } = await fetchAccount(stored)
      core.info("using stored PICO_SESSION.")
      return { ...stored, uid }
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error
      core.warning("stored PICO_SESSION has expired; logging in again.")
    }
  }

  const created = await loginWithPassword(email, password)
  const uid = created.uid ?? (await fetchAccount(created)).uid
  const pat = process.env.GH_PAT
  if (!pat) {
    throw new Error("missing GH_PAT; cannot save the PICO_SESSION secret")
  }
  await saveSession({ cookies: created.cookies, uid }, pat)
  core.info("saved new PICO_SESSION.")
  return { ...created, uid }
}
