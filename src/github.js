import { getOctokit } from "@actions/github"

export async function getReleaseState(tag) {
  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repository) throw new Error("missing GITHUB_REPOSITORY")
  if (!token) throw new Error("missing GITHUB_TOKEN")

  const [owner, repo] = repository.split("/")
  if (!owner || !repo)
    throw new Error(`invalid GITHUB_REPOSITORY: ${repository}`)

  const options = process.env.GITHUB_API_URL
    ? { baseUrl: process.env.GITHUB_API_URL }
    : {}
  const octokit = getOctokit(token, options)

  try {
    const { data } = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag,
    })
    return data.draft === true ? "draft" : "published"
  } catch (error) {
    if (error.status === 404) return "missing"
    throw new Error(
      `release lookup failed (${error.status ?? "no status"}): ${error.message}`,
      { cause: error },
    )
  }
}
