# usage-meter

A Claude Code mod that shows your usage live, above the prompt, without spending tokens:

```
Usage · contexte 240.1k/1.0M (24%) · session $14.33 · dernière requête $2.14 · session 5h 64% (reset 1h43) · semaine 28% (reset 1j19h)
```

- **Context**: tokens used in the current session and the share of the context window.
- **Cost**: the session's total and the last request (as `/cost` counts it).
- **Plan limits**: the 5-hour session and weekly windows, with the time left before each resets. The line refreshes every minute.

The labels are in French.

## Install

At a Claude Code prompt:

```
/plugin install usage-meter --marketplace wissKa/claude-usage-meter-mod
```

Answer `y` to add the marketplace, then choose a scope.

## Commands

| Command | Shows |
| --- | --- |
| `/usage-meter` | The same line as the band, in the transcript |
| `/usage-meter projets [jours]` | Tokens per project over the last N days (7 by default, 1 to 90) |

`/usage-meter projets` example:

```
Projets · 7 derniers jours · 214.9M tokens, dont 96% de cache lu
  161.9M   75%    3 sess    411 appels  sortie 454.5k  ~/work/project-a
   37.2M   17%    4 sess    122 appels  sortie 171.3k  ~/work/project-b
```

It reads Claude Code's local transcripts (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`) with `jq` on your machine, so the transcripts never go through the model. Each API call is counted once (Claude Code writes one reply as several transcript lines that repeat the same usage), subagent transcripts are included, and a session that moved into a subfolder stays with its project. It shows tokens, not dollars: on a subscription, API prices are not your bill.

## Requirements

- Claude Code with plugin hooks modules.
- `jq` on the `PATH` for `/usage-meter projets` (the rest works without it).

## Development

```bash
claude plugin validate .
claude plugin test .
```

To run it from a local folder instead of installing it:

```bash
claude --plugin-dir /path/to/usage-meter
```
