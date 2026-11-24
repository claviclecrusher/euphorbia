# Euphorbia

<img src="build/icon.svg" width="96" alt="Euphorbia icon"> <img src="build/icon-small.svg" width="48" alt="App icon">

A desktop client (Windows, Linux) for Overleaf servers: a self-hosted Community
Edition instance, overleaf.com, or both. Compiling and storage stay on the server.

*Unofficial; not affiliated with Overleaf.*

## Install

Download from the [latest release](https://github.com/claviclecrusher/euphorbia/releases/latest).

| Platform | File | Updates |
|---|---|---|
| Windows | `euphorbia-setup-<version>.exe` | automatic |
| Windows, no install | `euphorbia-portable-<version>.exe` | notification |
| Linux | `euphorbia-<version>.AppImage` | automatic |
| Debian/Ubuntu | `euphorbia_<version>_amd64.deb` | notification |
| macOS (Intel and Apple Silicon) | `euphorbia-<version>-mac.dmg` | notification |

The Windows files are not code-signed: on SmartScreen choose **More info → Run anyway**.
The macOS app is not signed with an Apple developer ID. The first time, open it,
then go to **System Settings → Privacy & Security** and choose **Open Anyway**
(or run `xattr -dr com.apple.quarantine /Applications/Euphorbia.app`). New
versions are announced in the app; download them from the releases page.
On Ubuntu 24.04+ the AppImage needs `libfuse2` and may need `--no-sandbox`.

## Features

- **Servers** — **Server** menu to add, remove and switch (`Ctrl+1`…`Ctrl+9`);
  sign-in is kept per server. Email/password sign-in only.
- **Copy a project to another server** — **More → Make a copy to other server**
  (files only; no history or comments).
- **Tabs and split editor** (self-hosted servers) — a tab per open document; `⇅`
  or drag a tab to split the editor top/bottom.
- **Candidates** (`Ctrl+Shift+I`) — keep alternative versions of some lines and
  switch between them; stored as comments in the `.tex` file.
- **Edits with diff** (`Ctrl+Shift+K`) — edit a copy of some lines next to the
  original, then **Accept** or **Reject**; shows who and when.
- **Window theme** — **View → Window Theme**: System, Light or Dark.
- **Updates** — checked at startup; **File → Check for Updates…** downloads,
  installs and restarts.

## AI

Set up connections in **File → AI Settings…**: Claude, OpenAI, and/or a local
OpenAI-compatible server such as Ollama. Keys stay on this computer. The local connection has one model, used for
everything local (chat, summaries, song-1), so the server never swaps models; it
is loaded when you open a project.

- **Connector** (optional): Claude Code on your own server as a model, through
  connector — enter its address, key
  and models (`connector-opus` …). No API cost; the subscription's limits apply.
  The Claude effort setting applies to it too.
- **`Ctrl+K`** rewrites the selected lines.
- **Chat panel** (under the file outline) answers questions about the whole
  project. `Ctrl+L` adds the selected lines to the message. Modes:
  **Edit** (may change files), **Read** (answers only), **Search** (highlights
  related places in yellow).
- **AI edits** — written into the file as edit blocks like `Ctrl+Shift+K`, with
  the old text kept as comments and the new text active (so your next compile
  uses it). Accept or Reject each, or use **Files**, **Accept all**, **Reject all**
  in the bar above the editor. Ask for more changes while they wait and the AI
  revises them; it can also compile and read the errors.
- `.bib` files are read-only for the AI. The AI can compile the project and read
  the errors and warnings (ask it about errors or a broken PDF).
- A **writing style** for research papers is applied to text the AI writes
  (editable in AI Settings). **Claude effort** defaults to low.
- The label next to the model menu estimates this month's spending from this
  app's own usage.
- Optional in AI Settings: a *summary model* (summarizes the project for the
  AI's index) and an *embedding model* (finds related passages, e.g. `bge-m3`).

**song-1** (in the chat's model menu when a local model and Claude are both set
up): the local model answers and reviews its own answer; if the answer looks weak,
Claude Opus 5.5 (effort low) takes over, and for hard requests it first plans
subtasks for the local model. Easy questions cost nothing.

## Development

    npm install
    npm start
    npm run release -- --build-only   # installers into dist/
    npm run release -- --draft        # also upload as a draft GitHub release

Bump `version` in `package.json` before a release. Icons: edit `build/icon.svg`
and `build/icon-small.svg`, then run `scripts/render-icons.sh`.

## About the name

*Euphorbia* 'Sotetsukirin' (괴마옥, 蘇鉄麒麟) is a small succulent, usually said to
be a hybrid of *E. bupleurifolia* and *E. susannae*. Its stem looks like a little
pine cone: green, covered in pointed tubercles that turn brown and corky toward
the base, with a tuft of thin leaves on top. It grows slowly, likes a lot of light
and very little water in winter, and sulks if overwatered. Like every Euphorbia it
bleeds a white latex when cut, which irritates skin, so handle it with care. The
name *sotetsu* means cycad, after that leafy crown.

## License

[AGPL-3.0](LICENSE). Formerly *Overleaf Desktop*; updating keeps your settings.
