// What God knows about Off Grid AI itself: what the product does, and where its news is posted.
// The overview ships with the app; the news is read from the public sources below only when the
// user asks about features or what is new. Parsers are pure so they are tested without network.

/** What Off Grid AI does today, in short. Kept with the app so God answers without network. */
export const OFFGRID_FEATURES = `Off Grid AI runs AI on your own computer and phone. Nothing you ask leaves your device unless you connect something that needs it.

Free on Desktop (macOS, Windows, Linux):
- Chat with text and vision models, with a thinking mode, answer versions and per-chat settings.
- Image generation from text or an image (SDXL-Lightning, SDXL, SD 1.5/2.1, Z-Image-Turbo), with live preview.
- Voice: speech to text with whisper, text to speech with Kokoro, and a hands-free voice mode.
- Artifacts: HTML, React, SVG, Mermaid and Markdown rendered live in a sandbox.
- Projects: group chats, add documents, and chat grounded in them with cited sources.
- Tools in chat: web search, read a page, calculator, memory search, and any MCP connector.
- Connectors (MCP) and direct account connections (Google, Microsoft, Obsidian), read live.
- Models: curated catalog and Hugging Face search, one active model per kind.
- The Gateway: one OpenAI-compatible endpoint at 127.0.0.1:7878 for other apps.
- God: this assistant. Chat or voice mode, wake word "Ares", knows your day, asks before it acts.

Pro (desktop):
- Sees and remembers: screen understanding into Day, Entities (a private CRM) and Replay.
- Reflect: where your attention went, by day and week.
- Meetings: records Google Meet and Zoom, transcribes on the device, summarises.
- Dictation: hold Option+Space, talk, and the text is pasted where your cursor is.
- Clipboard history with previews and a quick-paste popup.
- Acts with approval: action items, an approval queue with an audit log, Web Use and Computer Use.

Also: the Off Grid AI mobile app (iOS, Android) and the browser extension (Chrome, Firefox), which pairs with Desktop over a sealed local link.`

export type UpdateKind = 'release' | 'article' | 'community'

/** One piece of Off Grid AI news: a release, an article or a community post. */
export interface OffgridUpdate {
  readonly kind: UpdateKind
  readonly title: string
  readonly url: string
  /** ISO date, when the source gives one. */
  readonly date?: string
  /** Where it came from, for the answer: "Desktop release", "dev.to", ... */
  readonly source: string
  readonly summary?: string
}

/** Where Off Grid AI's news is posted. Public pages only; nothing about the user is sent. */
export const OFFGRID_SOURCES = {
  githubOrg: 'https://api.github.com/orgs/off-grid-ai/repos?sort=pushed&per_page=10&type=public',
  releases: (repo: string): string =>
    `https://api.github.com/repos/off-grid-ai/${encodeURIComponent(repo)}/releases?per_page=5`,
  articles: 'https://getoffgridai.co/articles',
  devTo: 'https://dev.to/api/articles?username=alichherawalla&per_page=10',
  reddit: 'https://www.reddit.com/r/off_grid_ai/new.json?limit=10'
} as const

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const isoDate = (v: unknown): string | undefined => {
  const t = Date.parse(text(v))
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}
const firstLine = (v: unknown, max = 200): string | undefined => {
  const line = text(v)
    .replace(/[#*_`>]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) {
    return undefined
  }
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

/** Public repository names from the GitHub org listing. */
export function parseOrgRepos(json: unknown): string[] {
  if (!Array.isArray(json)) {
    return []
  }
  return json
    .filter((r) => r && typeof r === 'object' && !(r as { archived?: boolean }).archived)
    .map((r) => text((r as { name?: unknown }).name))
    .filter(Boolean)
}

/** Published releases of one repository, newest first as GitHub returns them. */
export function parseGithubReleases(json: unknown, repo: string): OffgridUpdate[] {
  if (!Array.isArray(json)) {
    return []
  }
  return json.flatMap((r) => {
    const rel = r as Record<string, unknown>
    const url = text(rel.html_url)
    if (rel.draft === true || !url) {
      return []
    }
    return [
      {
        kind: 'release' as const,
        title: text(rel.name) || text(rel.tag_name) || 'Release',
        url,
        date: isoDate(rel.published_at),
        source: `${repo} release`,
        summary: firstLine(rel.body)
      }
    ]
  })
}

/** Articles from the dev.to API. */
export function parseDevTo(json: unknown): OffgridUpdate[] {
  if (!Array.isArray(json)) {
    return []
  }
  return json.flatMap((a) => {
    const art = a as Record<string, unknown>
    const url = text(art.url)
    const title = text(art.title)
    return url && title
      ? [
          {
            kind: 'article' as const,
            title,
            url,
            date: isoDate(art.published_at),
            source: 'dev.to',
            summary: firstLine(art.description)
          }
        ]
      : []
  })
}

/** Posts from the subreddit's JSON listing. */
export function parseReddit(json: unknown): OffgridUpdate[] {
  const children = (json as { data?: { children?: unknown } } | null)?.data?.children
  if (!Array.isArray(children)) {
    return []
  }
  return children.flatMap((c) => {
    const post = (c as { data?: Record<string, unknown> }).data ?? {}
    const title = text(post.title)
    const permalink = text(post.permalink)
    if (!title || !permalink.startsWith('/r/')) {
      return []
    }
    const created = typeof post.created_utc === 'number' ? post.created_utc * 1000 : NaN
    return [
      {
        kind: 'community' as const,
        title,
        url: `https://www.reddit.com${permalink}`,
        date: Number.isNaN(created) ? undefined : new Date(created).toISOString(),
        source: 'r/off_grid_ai',
        summary: firstLine(post.selftext)
      }
    ]
  })
}

/** Article links on getoffgridai.co/articles: every link under /articles/, titled by its text. */
export function parseArticleIndex(html: string, base = 'https://getoffgridai.co'): OffgridUpdate[] {
  const seen = new Set<string>()
  const out: OffgridUpdate[] = []
  const re = /<a\b[^>]*href="([^"]*\/articles\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < 10) {
    const url = new URL(m[1]!, base).toString()
    const title = m[2]!
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
    if (!title || seen.has(url) || !url.startsWith(base)) {
      continue
    }
    seen.add(url)
    out.push({ kind: 'article', title, url, source: 'getoffgridai.co' })
  }
  return out
}

/** The newest updates across sources: dated ones newest first, undated ones after, capped. */
export function newestUpdates(updates: readonly OffgridUpdate[], limit = 12): OffgridUpdate[] {
  const seen = new Set<string>()
  const unique = updates.filter((u) => !seen.has(u.url) && Boolean(seen.add(u.url)))
  const dated = unique.filter((u) => u.date).sort((a, b) => b.date!.localeCompare(a.date!))
  return [...dated, ...unique.filter((u) => !u.date)].slice(0, limit)
}

/** What the guide tool returns to the model: the feature overview, then the news it found. */
export function formatGuide(updates: readonly OffgridUpdate[], failed: readonly string[]): string {
  const news = updates.length
    ? updates
        .map((u) => {
          const when = u.date ? ` (${u.date.slice(0, 10)})` : ''
          const about = u.summary ? `\n   ${u.summary}` : ''
          return `- [${u.source}] ${u.title}${when}\n   ${u.url}${about}`
        })
        .join('\n')
    : 'No recent posts could be read.'
  const missing = failed.length ? `\nCould not reach: ${failed.join(', ')}.` : ''
  return `${OFFGRID_FEATURES}\n\nLatest from Off Grid AI:\n${news}${missing}\n\nWhen you mention a post or release, give its link.`
}

/** One line for God's instructions, so it reaches for the guide when it should. */
export const OFFGRID_GUIDE_HINT =
  "You are Off Grid AI's assistant. When the user asks what Off Grid AI can do, how to use a feature, or what is new, call offgrid_guide and answer from it with links."
