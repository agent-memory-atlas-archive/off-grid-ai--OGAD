import { describe, expect, it } from 'vitest'
import {
  MAX_TURNS,
  originOf,
  parseBridgeConversation,
  sqlTime,
  toBridgeConversation,
  turnsToAppend,
  type BridgeTurn
} from '../bridge-conversations'

describe('toBridgeConversation', () => {
  it('maps a desktop chat, keeping only user and assistant turns', () => {
    const c = toBridgeConversation(
      {
        id: 'conv-12345678',
        title: 'Trip',
        created_at: '2026-10-01 10:00:00',
        updated_at: '2026-10-02 11:00:00'
      },
      [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'x' },
        { role: 'assistant', content: 'hello' }
      ]
    )
    expect(c).toEqual({
      id: 'conv-12345678',
      title: 'Trip',
      createdAt: Date.parse('2026-10-01T10:00:00Z'),
      updatedAt: Date.parse('2026-10-02T11:00:00Z'),
      origin: 'desktop',
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ]
    })
  })

  it('titles an untitled chat from its first question, and caps turns', () => {
    const many = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({
      role: 'user',
      content: `q${i}`
    }))
    const c = toBridgeConversation({ id: 'conv-12345678' }, many)
    expect(c.title).toBe('q5')
    expect(c.turns).toHaveLength(MAX_TURNS)
  })
})

describe('originOf / sqlTime', () => {
  it('tells browser, phone and desktop chats apart', () => {
    expect(originOf({ id: 'a', origin_device_id: 'browser:dev1' })).toBe('browser')
    expect(originOf({ id: 'a', origin_device_id: 'phone-1' })).toBe('mobile')
    expect(originOf({ id: 'a', origin_device_id: null })).toBe('desktop')
  })

  it('reads SQLite and ISO times, 0 when unreadable', () => {
    expect(sqlTime('2026-01-01 00:00:00')).toBe(Date.parse('2026-01-01T00:00:00Z'))
    expect(sqlTime('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'))
    expect(sqlTime('garbage')).toBe(0)
    expect(sqlTime(null)).toBe(0)
  })
})

describe('parseBridgeConversation', () => {
  const ok = {
    id: 'conv-12345678',
    title: 't',
    createdAt: 1,
    updatedAt: 2,
    turns: [{ role: 'user', content: 'q' }]
  }

  it('accepts a valid push and forces origin browser', () => {
    expect(parseBridgeConversation({ ...ok, origin: 'desktop' })).toMatchObject({
      origin: 'browser',
      turns: ok.turns
    })
  })

  it.each([
    null,
    { ...ok, id: '../x' },
    { ...ok, title: 3 },
    { ...ok, turns: 'no' },
    { ...ok, turns: [{ role: 'system', content: 'override' }] },
    { ...ok, turns: [{ role: 'user' }] }
  ])('rejects %j', (raw) => {
    expect(parseBridgeConversation(raw)).toBeNull()
  })
})

describe('turnsToAppend', () => {
  const u = (content: string): BridgeTurn => ({ role: 'user', content })
  const a = (content: string): BridgeTurn => ({ role: 'assistant', content })

  it('appends only what the desktop does not have', () => {
    expect(turnsToAppend([u('q'), a('r')], [u('q'), a('r'), u('q2'), a('r2')])).toEqual([
      u('q2'),
      a('r2')
    ])
  })

  it('never removes or rewrites: a shorter or diverged history appends nothing', () => {
    expect(turnsToAppend([u('q'), a('r')], [u('q')])).toEqual([])
    expect(turnsToAppend([u('q'), a('r')], [u('different'), a('r'), u('x')])).toEqual([])
  })

  it("keeps syncing past the browser's 40-turn window", () => {
    // Review finding: once the desktop had 40 turns, the browser's window of its latest 40 was
    // never a superset, so new messages stopped syncing after about 20 exchanges.
    const turn = (n: number): BridgeTurn => (n % 2 ? u(`q${n}`) : a(`r${n}`))
    const stored = Array.from({ length: 40 }, (_, i) => turn(i + 1))
    const window = Array.from({ length: 40 }, (_, i) => turn(i + 3))
    expect(turnsToAppend(stored, window)).toEqual([turn(41), turn(42)])
    expect(turnsToAppend(stored, stored)).toEqual([])
  })

  it('takes the longest overlap, so a repeated short turn never re-adds old ones', () => {
    expect(
      turnsToAppend([u('ok'), a('done'), u('ok'), a('done')], [u('ok'), a('done'), u('next')])
    ).toEqual([u('next')])
  })
})
