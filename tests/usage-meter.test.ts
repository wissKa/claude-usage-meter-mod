import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-18T17:07:00Z')

test('/usage-meter prints context, cost and plan limits', async ($, on) => {
  // Answer $.session.usage() and $.clock.now() in Claude Code's place
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 84300, window: 200000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
      cost: 1.234,
    },
  }))
  on('clock.now', () => ({ value: NOW }))

  const answer = await $.command.run({ command: 'usage-meter', args: '' })
  expect(answer.text).toBe('Usage · contexte 84.3k/200.0k (42%) · session $1.23 · session 5h 12%')
})

test('/usage-meter shows the time left before each plan window resets', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1000000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 64, resetsAt: '2026-10-18T18:49:59Z' },
        { kind: 'seven_day', percentUsed: 28, resetsAt: '2026-10-20T12:59:59Z' },
      ],
    },
  }))
  on('clock.now', () => ({ value: NOW }))

  const answer = await $.command.run({ command: 'usage-meter', args: '' })
  expect(answer.text).toBe('Usage · session 5h 64% (reset 1h43) · semaine 28% (reset 1j19h)')
})

test('/usage-meter reads percentages as 0–100, so 0.4% is not shown as 40%', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 4000, window: 1000000, percent: 0.4 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 1 }],
    },
  }))
  on('clock.now', () => ({ value: NOW }))

  const answer = await $.command.run({ command: 'usage-meter', args: '' })
  expect(answer.text).toBe('Usage · contexte 4.0k/1.0M (0%) · session 5h 1%')
})

// A fake ~/.claude/projects: one project with a recent session, an old one, and a subagent transcript
type Run = { exitCode: number; stdout: string; stderr: string }
function fakeTranscripts(on: Parameters<Parameters<typeof test>[1]>[1], jq: (argv: readonly string[]) => Run) {
  const DAY = 86400000
  const tree: Record<string, { name: string; kind: 'file' | 'dir'; mtimeMs: number }[]> = {
    '/home/w/.claude/projects': [{ name: '-home-w-project', kind: 'dir', mtimeMs: 0 }],
    '/home/w/.claude/projects/-home-w-project': [
      { name: 'new.jsonl', kind: 'file', mtimeMs: NOW - DAY },
      { name: 'old.jsonl', kind: 'file', mtimeMs: NOW - 30 * DAY },
      { name: 'new', kind: 'dir', mtimeMs: 0 },
    ],
    '/home/w/.claude/projects/-home-w-project/new/subagents': [{ name: 'agent-1.jsonl', kind: 'file', mtimeMs: NOW - DAY }],
  }
  on('clock.now', () => ({ value: NOW }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/w' : undefined }))
  on('fs.list', ($, e) => {
    const entries = tree[e.path]
    if (!entries) throw new Error('ENOENT ' + e.path)
    return { value: entries.map(x => ({ ...x, size: 1, isLink: false })) }
  })
  on('process.run', ($, e) => ({ value: { ...jq(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }))
}

test('/usage-meter projets lists tokens per project, newest transcripts and subagents only', async ($, on) => {
  let argv: readonly string[] = []
  fakeTranscripts(on, a => {
    argv = a
    const rows = [
      { p: '/home/w/project', sessions: 2, calls: 40, input: 1000, cacheWrite: 9000, cacheRead: 880000, output: 10000 },
      { p: '/srv/other', sessions: 1, calls: 5, input: 100, cacheWrite: 900, cacheRead: 99000, output: 0 },
    ]
    return { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' }
  })

  const answer = await $.command.run({ command: 'usage-meter', args: 'projets 7' })

  expect(argv[0]).toBe('jq')
  expect(argv.slice(6)).toEqual([
    '/home/w/.claude/projects/-home-w-project/new.jsonl',
    '/home/w/.claude/projects/-home-w-project/new/subagents/agent-1.jsonl',
  ])
  expect(argv[4]).toBe(new Date(NOW - 7 * 86400000).toISOString())
  expect(answer.text).toBe([
    'Projets · 7 derniers jours · 1.0M tokens, dont 98% de cache lu',
    '  900.0k   90%    2 sess     40 appels  sortie  10.0k  ~/project',
    '  100.0k   10%    1 sess      5 appels  sortie      0  /srv/other',
  ].join('\n'))
})

test('/usage-meter projets says so when jq fails', async ($, on) => {
  fakeTranscripts(on, () => ({ exitCode: 3, stdout: '', stderr: 'jq: error: syntax\nmore' }))

  const answer = await $.command.run({ command: 'usage-meter', args: 'projets' })
  expect(answer.text).toBe('Projets · 7 derniers jours · jq a échoué : jq: error: syntax')
})
