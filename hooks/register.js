// usage-meter: live session usage above the prompt, plus a /usage-meter command.
// The data comes from $.session.usage(): { startedAt, context, rateLimits, cost }.

// Cost of the session at the end of the previous turn, to compute the last turn's cost
let costAtLastTurn = null
let lastTurnCost = null

function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function pct(v) {
  // The engine reports percentages as 0–100
  return Math.round(v) + '%'
}

// Plan windows as $.session.usage() names them
const LIMIT_LABELS = { five_hour: 'session 5h', seven_day: 'semaine', spend_limit: 'budget' }

// Time left until resetsAt (ISO 8601), e.g. "1h42" or "1j19h"
function resetIn(resetsAt, now) {
  const at = Date.parse(resetsAt || '')
  if (Number.isNaN(at) || typeof now !== 'number') return null
  const min = Math.max(0, Math.round((at - now) / 60000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return d + 'j' + h + 'h'
  if (h > 0) return h + 'h' + String(m).padStart(2, '0')
  return m + 'min'
}

function costUsd(u) {
  const c = u && u.cost
  if (typeof c === 'number') return c
  if (c && typeof c === 'object') {
    for (const k of ['totalUsd', 'usd', 'totalCostUsd', 'total', 'amount']) {
      if (typeof c[k] === 'number') return c[k]
    }
  }
  return null
}

function summary(u, now) {
  const parts = []
  const ctx = u && u.context
  if (ctx && typeof ctx.tokens === 'number') {
    let s = 'contexte ' + fmt(ctx.tokens)
    if (typeof ctx.window === 'number') s += '/' + fmt(ctx.window)
    if (typeof ctx.percent === 'number') s += ' (' + pct(ctx.percent) + ')'
    parts.push(s)
  }
  const cost = costUsd(u)
  if (cost !== null) parts.push('session $' + cost.toFixed(2))
  if (lastTurnCost !== null) parts.push('dernière requête $' + lastTurnCost.toFixed(2))
  const limits = (u && u.rateLimits) || []
  for (const r of limits) {
    if (!r || typeof r.percentUsed !== 'number') continue
    let s = (LIMIT_LABELS[r.kind] || r.kind || 'limite') + ' ' + pct(r.percentUsed)
    const left = resetIn(r.resetsAt, now)
    if (left !== null) s += ' (reset ' + left + ')'
    parts.push(s)
  }
  return parts.length ? 'Usage · ' + parts.join(' · ') : 'Usage · pas encore de données'
}

// ── Per-project view: /usage-meter projets [jours] ──────────────────
// Token totals per project from Claude Code's local transcripts, extracted by jq on the
// host so the transcripts never reach the model (and files over $.fs.read's 4 MiB work).
// One API call is written as several transcript lines that repeat the same usage block,
// so each call is counted once, by message id. Subagent transcripts are included: their
// calls count against the plan limits too. Calls are grouped by the transcript's project
// folder (a session that cd's into a subfolder stays in its project), labelled with the
// shortest working directory seen in it, the project's root.
const JQ_PROGRAM = `
[inputs | fromjson? | select(type == "object" and .type == "assistant"
    and (.message.usage | type) == "object" and .message.model != "<synthetic>"
    and (.timestamp // "") >= $since)
  | {k: (.message.id // .uuid // "?"),
     f: (input_filename | sub("/[^/]+[.]jsonl$"; "") | sub("/[^/]+/subagents$"; "")),
     c: (.cwd // ""), s: (.sessionId // ""),
     u: (.message.usage | [(.input_tokens // 0), (.cache_creation_input_tokens // 0),
                           (.cache_read_input_tokens // 0), (.output_tokens // 0)])}]
| unique_by(.k) | group_by(.f)
| map({p: (map(.c) | map(select(. != "")) | min_by(length) // (.[0].f | split("/") | last)),
       sessions: (map(.s) | unique | length), calls: length,
       input: (map(.u[0]) | add), cacheWrite: (map(.u[1]) | add),
       cacheRead: (map(.u[2]) | add), output: (map(.u[3]) | add)})
`

const DAY_MS = 86400000

async function transcriptFiles($, root, sinceMs) {
  const files = []
  const add = (dir, entries) => {
    for (const f of entries) {
      if (f.kind === 'file' && f.name.endsWith('.jsonl') && f.mtimeMs >= sinceMs) files.push(dir + '/' + f.name)
    }
  }
  const projects = await $.fs.list(root).catch(() => [])
  for (const p of projects) {
    if (p.kind !== 'dir') continue
    const dir = root + '/' + p.name
    const entries = await $.fs.list(dir).catch(() => [])
    add(dir, entries)
    // <project>/<session>/subagents/*.jsonl
    for (const s of entries) {
      if (s.kind !== 'dir') continue
      const sub = dir + '/' + s.name + '/subagents'
      add(sub, await $.fs.list(sub).catch(() => []))
    }
  }
  return files
}

async function projectsReport($, days) {
  const now = await $.clock.now()
  const sinceMs = now - days * DAY_MS
  const home = (await $.env.get('HOME')) || ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || home + '/.claude'
  const files = await transcriptFiles($, configDir + '/projects', sinceMs)
  const title = 'Projets · ' + days + ' derniers jours'
  if (!files.length) return title + ' · aucune session'

  let res
  try {
    res = await $.process.run(
      ['jq', '-nR', '--arg', 'since', new Date(sinceMs).toISOString(), JQ_PROGRAM, ...files],
      { timeoutMs: 120000 },
    )
  } catch (err) {
    return title + ' · jq introuvable ou trop lent (' + String((err && err.message) || err) + ')'
  }
  if (res.exitCode !== 0) return title + ' · jq a échoué : ' + (res.stderr.trim().split('\n')[0] || 'code ' + res.exitCode)

  const rows = JSON.parse(res.stdout || '[]')
    .map(r => ({ ...r, total: r.input + r.cacheWrite + r.cacheRead + r.output }))
    .sort((a, b) => b.total - a.total)
  if (!rows.length) return title + ' · aucune session'
  const sum = rows.reduce((s, r) => s + r.total, 0)
  const cacheRead = rows.reduce((s, r) => s + r.cacheRead, 0)
  const shortPath = p => {
    const s = home && p.startsWith(home) ? '~' + p.slice(home.length) : p
    return s.length > 50 ? '…' + s.slice(-49) : s
  }

  const lines = [title + ' · ' + fmt(sum) + ' tokens, dont ' + pct((cacheRead / sum) * 100) + ' de cache lu']
  for (const r of rows.slice(0, 10)) {
    lines.push(
      '  ' + fmt(r.total).padStart(6) + '  ' + pct((r.total / sum) * 100).padStart(4) +
      '  ' + String(r.sessions).padStart(3) + ' sess  ' + String(r.calls).padStart(5) + ' appels' +
      '  sortie ' + fmt(r.output).padStart(6) + '  ' + shortPath(r.p),
    )
  }
  if (rows.length > 10) lines.push('  … et ' + (rows.length - 10) + ' autres projets')
  return lines.join('\n')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-meter',
      description: "Usage de la session (contexte, coût, limites) ; « projets [jours] » : tokens par projet",
    })
    // Redraw once a minute so the reset countdowns stay current between turns
    $.clock.every(60000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  // After each answer: remember the turn's cost and redraw the band
  on('turn.complete', async ($, e, next) => {
    const u = await $.session.usage()
    const cost = costUsd(u)
    if (cost !== null) {
      if (costAtLastTurn !== null) lastTurnCost = Math.max(0, cost - costAtLastTurn)
      costAtLastTurn = cost
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Usage or plan limits changed: redraw the band
  on('session.measure', async ($, e, next) => {
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // The band above the prompt: one dim line, keeping what other mods draw there
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const u = await $.session.usage()
    const now = await $.clock.now()
    const theirs = await next(e)
    const line = Text({ dimColor: true, children: [summary(u, now)] })
    return Box({ flexDirection: 'column', children: theirs ? [theirs, line] : [line] })
  })

  // /usage-meter prints the same summary in the transcript;
  // /usage-meter projets [jours] prints tokens per project (7 days by default)
  on('command.run', { command: 'usage-meter' }, async ($, e) => {
    const [sub, n] = (e.args || '').trim().split(/\s+/)
    if (sub === 'projets' || sub === 'projects' || sub === 'p') {
      const days = Math.min(90, Math.max(1, parseInt(n, 10) || 7))
      return { text: await projectsReport($, days) }
    }
    const u = await $.session.usage()
    return { text: summary(u, await $.clock.now()) }
  })
}
