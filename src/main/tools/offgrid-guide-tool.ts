// The offgrid_guide tool: what Off Grid AI does, and what is new, from its public release notes,
// articles and community. Reads public pages only, and only when God or chat calls it.
// Wiring only: parsing and formatting are in shared/offgrid-guide.ts, tested.

import {
  OFFGRID_SOURCES,
  formatGuide,
  newestUpdates,
  parseArticleIndex,
  parseDevTo,
  parseGithubReleases,
  parseOrgRepos,
  parseReddit,
  type OffgridUpdate
} from '../../shared/offgrid-guide'

const HEADERS = { 'User-Agent': 'OffGridAI-Desktop', Accept: 'application/json, text/html' }
// Release notes from the most recently pushed public repositories.
const RELEASE_REPOS = 4

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8_000) })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return res
}

async function releases(): Promise<OffgridUpdate[]> {
  const repos = parseOrgRepos(await (await get(OFFGRID_SOURCES.githubOrg)).json())
  const lists = await Promise.all(
    repos.slice(0, RELEASE_REPOS).map(async (repo) =>
      parseGithubReleases(
        await (await get(OFFGRID_SOURCES.releases(repo))).json().catch(() => []),
        repo
      )
    )
  )
  return lists.flat()
}

const SOURCES: ReadonlyArray<{ name: string; read: () => Promise<OffgridUpdate[]> }> = [
  { name: 'GitHub releases', read: releases },
  {
    name: 'getoffgridai.co',
    read: async () => parseArticleIndex(await (await get(OFFGRID_SOURCES.articles)).text())
  },
  { name: 'dev.to', read: async () => parseDevTo(await (await get(OFFGRID_SOURCES.devTo)).json()) },
  {
    name: 'r/off_grid_ai',
    read: async () => parseReddit(await (await get(OFFGRID_SOURCES.reddit)).json())
  }
]

export const offgridGuideTool = {
  name: 'offgrid_guide',
  description:
    "What Off Grid AI can do (free and Pro, desktop, mobile, browser extension) and what is new: latest releases, articles and community posts. Use when the user asks about Off Grid AI's features, how to do something in it, or what changed. Reads public pages; requires network for the news.",
  parameters: { type: 'object', properties: {} },
  run: async (): Promise<string> => {
    const results = await Promise.allSettled(SOURCES.map((s) => s.read()))
    const failed = SOURCES.filter((_, i) => results[i]!.status === 'rejected').map((s) => s.name)
    const updates = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    return formatGuide(newestUpdates(updates), failed)
  }
}
