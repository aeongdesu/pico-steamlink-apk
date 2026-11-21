import * as core from "@actions/core"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getReleaseState } from "./github.js"
import { resolveSession } from "./session.js"
import { downloadApk, fetchDownloadInfo } from "./store.js"

const CHANNELS = [
  { name: "stable", devPreview: false },
  { name: "beta", devPreview: true },
]

async function publishChannel(channel, session) {
  const apk = await fetchDownloadInfo(session, {
    devPreview: channel.devPreview,
  })
  const version = apk.version.replace(/[^0-9A-Za-z._-]+/g, "-")
  const tag = `steamlink-${channel.name}-v${version}-${apk.versionCode}`
  const name = `Steam Link ${version}-${apk.versionCode} (${channel.name})`

  core.setOutput(`${channel.name}_tag`, tag)
  core.setOutput(`${channel.name}_name`, name)
  core.setOutput(`${channel.name}_version`, version)
  core.setOutput(`${channel.name}_version_code`, apk.versionCode)
  core.setOutput(`${channel.name}_md5`, apk.md5)
  core.info(`[${channel.name}] ${name}`)

  const releaseState = await getReleaseState(tag)
  if (releaseState === "published") {
    core.notice(
      `[${channel.name}] release ${tag} is already published, nothing to publish`,
    )
    core.setOutput(`${channel.name}_release`, "false")
    return
  }
  if (releaseState === "draft") {
    core.notice(`[${channel.name}] reusing draft release ${tag}`)
  }

  const dist = "dist"
  await mkdir(dist, { recursive: true })
  const apkPath = join(dist, `${tag}.apk`)
  core.info(`[${channel.name}] downloading ${apk.url}`)
  const downloaded = await downloadApk(apk.url, apkPath, apk.md5)
  core.info(
    `[${channel.name}] downloaded ${downloaded.bytes} bytes; MD5 verified`,
  )
  core.setOutput(`${channel.name}_apk`, apkPath)
  core.setOutput(`${channel.name}_release`, "true")
}

async function main() {
  const session = await resolveSession()
  for (const channel of CHANNELS) {
    await publishChannel(channel, session)
  }
  core.info("ready to publish")
}

main().catch((error) => {
  core.setFailed(error.message)
  if (process.env.DEBUG) core.error(`debug: ${error.stack}`)
})
