const TIMEOUT_MS = 30_000

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchWithRetry(
  url,
  init = {},
  attempts = 3,
  timeoutMs = TIMEOUT_MS,
) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
      return await fetch(url, signal === undefined ? init : { ...init, signal })
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(attempt * 1_000)
    }
  }
  throw new Error(
    `request failed: ${url}: ${lastError?.message ?? "unknown error"}`,
    {
      cause: lastError,
    },
  )
}

export async function fetchOnce(url, init = {}) {
  return fetchWithRetry(url, init, 1)
}

export async function readJson(response, label) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    const excerpt = text.slice(0, 500)
    throw new Error(
      `${label}: expected JSON but received HTTP ${response.status}: ${excerpt}`,
    )
  }
}

export function errorText(value) {
  return String(value ?? "unknown error").slice(0, 500)
}
