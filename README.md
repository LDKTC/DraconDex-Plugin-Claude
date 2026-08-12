# DraconDex-Plugin-Claude

A Claude chat session for [DraconDex](https://github.com/LDKTC/App-DraconDex),
docked in place of the Module Inspector.

Install it, open any module, and a **💬** button appears next to the Module
Inspector toggle. Click it and the Inspector dock is replaced by a chat panel
scoped to that module. It also runs as a standalone window if you'd rather have
the room.

> Requires **DraconDex 4.3.0+** for the docked panel. On 4.2.x it still installs
> and works as a plain window (Settings → Plugin → Launch) — there is just no
> button in the main window, because the panel API doesn't exist there yet.
> **DraconDex 4.8.0+** additionally auto-installs
> [AI Native](https://github.com/LDKTC/DraconDex-Plugin-Native) the first time
> this plugin is installed (see [App context](#app-context-ai-native) below).
> On older versions this plugin still installs and works exactly the same —
> the app just doesn't know to look at the manifest's `dependencies` field
> yet, so nothing else gets pulled in automatically.

## Connecting

Two modes, in Settings inside the plugin.

### API key

Paste an [Anthropic API key](https://console.anthropic.com/). That's the whole
setup, and it works today.

### Subscription (OAuth)

Two ways to end up with a token here — both stored and sent identically
(`Authorization: Bearer …` + `anthropic-beta: oauth-2025-04-20`).

#### Local CLI

Run `claude setup-token` with the Claude Code CLI on this machine — it
authenticates against your existing Claude subscription and prints a token, no
OAuth client of your own required. Already signed in there (`claude login`)?
That session's token works the same way. Paste it into Settings → Subscription
→ Local CLI.

This plugin never runs the CLI itself — a plugin page has no process access to
do that, by design (see
[App-DraconDex's `docs/PLUGINS.md`](https://github.com/LDKTC/App-DraconDex/blob/main/docs/PLUGINS.md)
§2.4). It only accepts whatever token the CLI already produced, the same way
it would accept one from Sign-in below.

#### Sign in

**Read this before choosing it.** Anthropic publishes no API for driving a
Claude Pro/Max subscription from a third-party app, and this plugin does not
invent one. What this implements is a standard **OAuth 2.0 + PKCE** client
against endpoints *you* supply:

| Field | What it is |
| --- | --- |
| Client ID | The `client_id` of an OAuth client you are entitled to use |
| Authorize URL | Its authorization endpoint |
| Token URL | Its token endpoint |
| Scope | Optional, passed through to the authorize request |

Sign-in opens your system browser and captures the redirect through DraconDex
(a plugin page can't listen on a port). The token exchange happens inside the
plugin, so a client secret never leaves it. Access tokens are refreshed
automatically before they expire.

That token exchange is itself a `pluginApi.net` call, so it is held to the same
manifest allowlist as everything else this plugin sends —
`https://api.anthropic.com` or `https://raw.githubusercontent.com`, nothing
else (see [The manifest](#the-manifest)). In practice, Sign-in only works if
your OAuth client's token endpoint happens to live on one of those two hosts;
most don't. Local CLI above sidesteps this entirely — it makes no
token-endpoint request of its own, since the CLI already completed that
exchange for you.

If neither fits, use API key mode.

## What it can do

- Streams replies token by token
- Model picker (Claude Opus 5 by default, plus Sonnet 5 / Haiku 4.5 / Opus 4.8)
- Optional effort level and a summarised view of Claude's reasoning
- Optional system prompt, adjustable max tokens
- One conversation per module, kept separate, plus a History tab
- Surfaces refusals, rate limits, and API errors as themselves, with Retry —
  rather than swallowing them

## App context (AI Native)

This plugin declares
[DraconDex-Plugin-Native](https://github.com/LDKTC/DraconDex-Plugin-Native)
("AI Native") as a manifest `dependencies` entry, so installing this plugin
auto-installs that one too (DraconDex 4.8.0+). AI Native publishes
`catalog.json` — a small public file describing DraconDex's features and what
a plugin can/can't do.

A plugin can't read another plugin's table or files even once both are
installed side by side, so this plugin doesn't reach into AI Native directly —
instead, on boot it fetches `catalog.json` straight from that repo
(`https://raw.githubusercontent.com`, declared in `permissions.net`) and
folds a short summary into the system prompt sent with every message, ahead
of whatever you wrote in Settings. That's the entire mechanism: your own
system prompt is never edited or replaced, just prefixed for the outgoing
request. No internet access to that host, or an older DraconDex with no
`pluginApi.net`? Chat still works fine — just without the app-context
preamble.

## Where your data goes

- **Conversations** live in this plugin's own SQLite tables inside your vault
  (`plg_claude_chat_session` / `_message` / `_config`). They are never sent
  anywhere except to the Anthropic API as conversation history.
- **Your API key and OAuth tokens** are stored in that same `config` table **in
  plain text**. DraconDex has no encrypted credential store — it keeps its own
  Google Drive client secret the same way — so this is consistent with the rest
  of the app, not better than it. Treat your vault file accordingly.
- **Network access** is restricted by the manifest to `https://api.anthropic.com`
  and nothing else. DraconDex shows that host in the install preview before you
  confirm, and enforces it at runtime.

## The manifest

```json
{
  "id": "claude_chat",
  "name": "Claude Chat",
  "entry": "index.html",
  "files": ["index.html", "panel.html", "…"],
  "panels": [
    { "id": "chat", "title": "Claude", "icon": "💬", "entry": "panel.html" }
  ],
  "permissions": {
    "net": ["https://api.anthropic.com", "https://raw.githubusercontent.com"],
    "context": ["module"]
  },
  "dependencies": ["https://github.com/LDKTC/DraconDex-Plugin-Native"],
  "tables": [ "…" ]
}
```

`panels` and `permissions` are the DraconDex 4.3.0 additions; `dependencies`
is 4.8.0 (see [App context](#app-context-ai-native) above); everything else
is the plugin format from 4.2.0. Full rules are in
[App-DraconDex's `docs/PLUGINS.md`](https://github.com/LDKTC/App-DraconDex/blob/main/docs/PLUGINS.md).

`permissions.context: ["module"]` lets the panel receive the open module's id,
name and kind — enough to keep one conversation per module and to title it.
Nothing about the module's *content* is shared.

## Structure

| File | Purpose |
| --- | --- |
| `dracondex-plugin.json` | Manifest: id, files, panel, permissions, table schema. |
| `index.html` + `app.js` | Standalone-window entry (draws its own title bar). |
| `panel.html` + `panel.js` | Docked-panel entry; asks the host for module context. |
| `src/store.js` | The three tables, via `window.pluginApi.table.*`. |
| `src/provider.js` | Messages API client + both auth modes. |
| `src/catalog.js` | Fetches/caches AI Native's `catalog.json`; composes the app-context preamble onto the system prompt. |
| `src/chat.js` | Session and turn state; no DOM. |
| `src/ui.js` | Rendering. Builds nodes, never HTML strings. |
| `style.css` | Dark theme matching the app; works at 290px and at 900px. |
| `scripts/validate-manifest.mjs` | Local manifest check. Not shipped — it isn't in `files`. |

Both entries load the same four `src/` scripts and differ only in chrome.

### A constraint worth knowing if you fork this

A docked panel is **reloaded whenever DraconDex re-renders its pane** — editing
a tag on the module is enough. Nothing may live only in a variable. Every
message is written to the table at the moment it exists (the question before the
request goes out, the answer as soon as the stream ends), and the panel rebuilds
itself from the tables on every load. A reply that was still streaming when a
reload happened is the only thing that can be lost.

## Developing

```bash
node scripts/validate-manifest.mjs        # same rules the app enforces on install
node --check app.js panel.js src/*.js
```

Then in DraconDex: **Settings → Plugin → Plugins**, paste this repo's link,
confirm the preview. Reinstalling after a change means uninstalling first (the
same `id` can't install twice), and **uninstalling permanently deletes this
plugin's conversations** — so don't develop against a vault you care about.

## License

MIT, see [LICENSE](LICENSE).
