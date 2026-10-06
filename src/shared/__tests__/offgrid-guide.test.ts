import { describe, expect, it } from 'vitest'
import {
  OFFGRID_FEATURES,
  formatGuide,
  newestUpdates,
  parseArticleIndex,
  parseDevTo,
  parseGithubReleases,
  parseOrgRepos,
  parseReddit
} from '../god/offgrid-guide'

describe('Off Grid AI guide', () => {
  it('reads public repos, skipping archived ones and junk', () => {
    expect(parseOrgRepos([{ name: 'mobile' }, { name: 'old', archived: true }, 3])).toEqual([
      'mobile'
    ])
    expect(parseOrgRepos({ message: 'rate limited' })).toEqual([])
  })

  it('reads published releases with their first note line', () => {
    const out = parseGithubReleases(
      [
        {
          name: 'v0.0.41',
          html_url: 'https://github.com/off-grid-ai/mobile/releases/v0.0.41',
          published_at: '2026-10-01T10:00:00Z',
          body: '## God\n\n* Chat or voice mode'
        },
        { name: 'draft', html_url: 'https://x', draft: true }
      ],
      'mobile'
    )
    expect(out).toEqual([
      {
        kind: 'release',
        title: 'v0.0.41',
        url: 'https://github.com/off-grid-ai/mobile/releases/v0.0.41',
        date: '2026-10-01T10:00:00.000Z',
        source: 'mobile release',
        summary: 'God'
      }
    ])
  })

  it('reads dev.to articles and subreddit posts', () => {
    expect(
      parseDevTo([
        { title: 'Local AI', url: 'https://dev.to/a/local', published_at: '2026-09-01T00:00:00Z' }
      ])[0]
    ).toMatchObject({ kind: 'article', source: 'dev.to', title: 'Local AI' })
    const posts = parseReddit({
      data: {
        children: [
          { data: { title: 'v41 is out', permalink: '/r/off_grid_ai/comments/1/', created_utc: 1 } },
          { data: { title: 'no link', permalink: 'https://evil.example' } }
        ]
      }
    })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('https://www.reddit.com/r/off_grid_ai/comments/1/')
  })

  it('finds article links on the site once each, on the site only', () => {
    const html = `<a href="/articles/private-ai">Private <b>AI</b> &amp; you</a>
      <a href="/articles/private-ai">dup</a>
      <a href="https://elsewhere.example/articles/x">off site</a>
      <a href="/pro">Pro</a>`
    expect(parseArticleIndex(html)).toEqual([
      {
        kind: 'article',
        title: 'Private AI & you',
        url: 'https://getoffgridai.co/articles/private-ai',
        source: 'getoffgridai.co'
      }
    ])
  })

  it('orders news newest first, undated last, once each, and says what it could not reach', () => {
    const a = { kind: 'article' as const, title: 'A', url: 'u1', source: 's', date: '2026-01-01' }
    const b = { kind: 'release' as const, title: 'B', url: 'u2', source: 's', date: '2026-02-01' }
    const c = { kind: 'article' as const, title: 'C', url: 'u3', source: 's' }
    expect(newestUpdates([c, a, b, a]).map((u) => u.title)).toEqual(['B', 'A', 'C'])
    const text = formatGuide([b], ['dev.to'])
    expect(text.startsWith(OFFGRID_FEATURES)).toBe(true)
    expect(text).toContain('- [s] B (2026-02-01)\n   u2')
    expect(text).toContain('Could not reach: dev.to.')
    expect(formatGuide([], [])).toContain('No recent posts could be read.')
  })
})
