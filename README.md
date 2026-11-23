# Overleaf Desktop

An Electron desktop client for Overleaf servers: a self-hosted Community Edition
instance, overleaf.com, or both. Compiling and project storage stay on the server,
so the same server remains usable from a web browser.

## Install

Download an installer from the [latest release](https://github.com/claviclecrusher/overleaf-desktop/releases/latest).

| Platform | File | Updates |
|---|---|---|
| Windows | `overleaf-desktop-setup-<version>.exe` | automatic |
| Windows, no install | `overleaf-desktop-portable-<version>.exe` | notification only |
| Linux | `overleaf-desktop-<version>.AppImage` | automatic |
| Debian/Ubuntu | `overleaf-desktop_<version>_amd64.deb` | notification only |

The Windows executables are not code-signed, so SmartScreen warns on first run:
choose **More info → Run anyway**.

The app asks for a server address on first launch.

## Window theme

**View → Window Theme** chooses the window colours: **System** (follow the
operating system, the default), **Light** or **Dark**. The choice is remembered. It
sets the window frame where the operating system lets apps choose it (the title
bar on Windows), the app's own dialogs, and the colour scheme pages are told to
prefer. On Linux desktops that draw window frames themselves (e.g. GNOME) the frame
follows the desktop theme instead. Overleaf's own editor colours are set in
Overleaf's settings.

## Servers

The **Server** menu lists the saved servers; picking one switches to it
(`Ctrl+1` to `Ctrl+9`). **Add Server…** registers another, and
**Remove Current Server…** drops the current one from the list. Sign-in state is
kept separately for each server.

Only email and password sign-in is supported. Google, ORCID and institutional SSO
buttons are hidden, because Google refuses sign-in from embedded browsers and a
session created in the system browser cannot be passed to the app. If your
overleaf.com account has no password yet, set one with "Forgot your password?" on
the login page. Links that leave the server open in the system browser.

## Copying a project to another server

Tick one project in the project list and choose **More → Make a copy to other
server** (or **File → Copy Project to Another Server…**, which also works from
inside an open project). The app downloads the project as a zip from the current
server and uploads it to the chosen server as a new project. You must be signed in
to both servers in the app.

The copy contains the project's files. History, comments, tracked changes and
collaborators are not copied, and the target server's upload size limit applies.

The server list and window position are stored in `config.json` in the user data
folder (`~/.config/Overleaf Desktop/` on Linux, `%APPDATA%\Overleaf Desktop\` on
Windows).

## Editor tabs

On self-hosted servers, every document you open in a project gets a tab above
the editor. Click a tab to
switch to it, `×` or a middle click to close it, and drag tabs to reorder them.
Tabs are remembered per project on this computer. Overleaf still edits one
document at a time; switching a tab opens that document as if it had been clicked
in the file tree, including inside collapsed folders.

On overleaf.com the app's tabs and split editor are turned off, since
overleaf.com has its own editor tabs.

### Split editor

The editor can be split into a top and a bottom pane, each with its own tabs.
Send a tab to the other pane with its `⇅` button, its right-click menu, or by
dragging it onto the other pane's tab strip. Dragging a tab onto the lower half
of a single editor splits it. Drag the bar between the panes to resize them.
When the bottom pane has no tabs left, the editor goes back to a single pane.

The bottom pane is a second copy of the project page showing only its editor,
kept in sync through the server like a collaborator. The file tree and the PDF
belong to the top pane; `Ctrl+Enter` / `Ctrl+S` in the bottom pane compile there.

## Candidates

Candidates keep several alternative versions of a block of lines side by side, so
you can switch between them while deciding which one to keep.

- Select some lines and press `Ctrl+Shift+I` to turn them into a candidate block.
  A bar appears above the block with one button per candidate.
- `+` (or `Ctrl+Shift+I` with the cursor inside the block) adds a candidate. It
  starts as a copy of the active one; edit it into the alternative.
- Click a candidate to switch to it. Double-click to rename it, `×` to delete it.
- **Keep active** ends the block: the active text stays and the others are removed.

Only the active candidate is compiled. Everything is stored in the `.tex` source as
comments, so candidates survive across devices, collaborators and project copies:

    %%cand:begin id=k3f9
    %%cand:option name="short"
    %| We propose a method.
    %%cand:option name="long" active
    We propose a novel method that
    improves stability.
    %%cand:end

In a web browser the block shows as this plain text. Selections always extend to whole lines, and blocks cannot be nested.

Each candidate records who added it (Overleaf account name) and when; the active
one's is shown in small type in the bar, the others' in each name's tooltip.

## Edits with diff

Select some lines and press `Ctrl+Shift+K` to edit them while keeping the
original. The original stays visible above on a red background (read-only), and
you edit the copy below on a green background. **Accept** keeps the new text and
drops the old; **Reject** keeps the old text and drops the new. The block shows
who started the edit and when.

Every edit block also shows its place among all edits in the project (`‹ 3/7 ›`);
the arrows move to the previous or next edit, opening other files as needed.
Edit blocks are accepted or rejected one by one (Accept all / Reject all are for AI
suggestions only, see below). Edits in files other than the open one are counted from the app's
copy of the project, so a new edit in another file can take a little while to be
counted.

The new text is what compiles; the old text is kept in the source as comments:

    %%edit:begin by="Alice Kim" at="2026-11-23 14:05"
    %- We propose a method.
    %%edit:new
    We propose a novel method.
    %%edit:end

## AI

### AI suggestions (only you see them)

Changes made by the AI (`Ctrl+K` and chat edits) are **AI suggestions**, not edit
blocks. They are kept only in this app on this computer (per project); the file
on the server keeps the original text, so collaborators and the PDF see the
original until you press **Accept**, which writes the suggestion into the file.
**Reject** discards it. In the editor the original lines are marked purple and the
suggested text appears below them in a blue box, headed by the model and the time.

While there are AI suggestions in the project, one purple bar above the editor
shows how many there are, with **Files** (the files that have suggestions and how
many each; click one to open it at its first suggestion) and **Accept all** /
**Reject all**. These apply only to
AI suggestions; edit blocks made by people are left alone. Suggestions count
together with edit blocks in each item's `‹ n/N ›`. A suggestion cannot be edited before it is accepted (accept it, then
edit, or ask the AI again). If the original text changes before you accept (for
example a collaborator rewrites it), the suggestion no longer matches and is not
shown; Accept refuses it.

### Connections and models

**File → AI Settings…** holds the connections: Claude (API key), OpenAI (API key),
and a local OpenAI-compatible server (address, e.g. Ollama
`http://<host>:11434/v1`). Each has a list of models, one per line; **Fetch model
list** asks the server what it offers and **Save & Test** sends a one-line request.
Every listed model of every working connection appears in the model menus of
`Ctrl+K` and the chat panel. Keys stay on this computer (encrypted with the system
keychain when available) and are used only by the app, never by the Overleaf page.

### Writing style

Text the AI writes into the paper (Ctrl+K rewrites and chat edits) follows a set of
writing rules for AI research papers, shown and editable in **AI Settings → Writing
style**: short, plain sentences (about 15-25 words) with one idea each; no filler
or inflated words; "we" and active voice; present tense for claims and method, past
tense for experiments run; precise claims with numbers instead of adjectives; one
term per concept and the paper's own notation; defined abbreviations; and LaTeX
conventions such as `Figure~\ref{...}`. The rules also forbid adding or dropping
claims when rewriting and guessing author names from citation keys. Untick the box
to turn them off, edit the text to make them your own, or **Reset to default**.
Chat replies themselves are not affected.

### Ctrl+K: edit the selection

Select lines, press `Ctrl+K`, pick a model, type what to change and press Enter.
The rewrite comes back as an AI suggestion (**Accept** / **Reject**) marked
`AI (<model>)`. The selection and up to 20 lines around it are sent.

### AI Chat panel

The panel under File tree / File outline (collapsible, resizable; widen the left
sidebar for more room) is a chat about the whole project. `Ctrl+L` adds the
selected lines to the message as a link (`main.tex:12-18`); clicking a link jumps
there. When you ask for a change, the model's edits become AI suggestions in the
files (no file is switched or changed until you accept); an edit that can't be
placed is listed with the reason and a **Try again** button.

The row under the message box holds the **model** menu (left; hover for the
provider), this month's **spending** for that model's provider, the **mode** button
and Send. Spending is estimated from the token usage the APIs report for every
request this app makes (chat, Ctrl+K, summaries, embeddings), priced per model;
hover it for a per-model breakdown. Claude models are priced; models without a
known price (OpenAI) show tokens instead; local models show "free". Use made by
other apps or computers with the same key is not included (the APIs do not report
account balances). The label is hidden when the row is too narrow to show it
whole. The mode button cycles through three modes, and each message
carries its mode to the model:

- **Edit**: the AI may change the files, as edits to accept or reject.
- **Read**: it reads and answers but changes nothing (edits it writes anyway are
  not applied).
- **Search**: it finds the places related to your passage or question (point at
  one with `Ctrl+L`): the same notation, related experiments, theory, citations
  and bibliography entries. They are listed in the chat and shown with a yellow
  background in the editor, with a yellow bar above the editor to step through
  them (`‹ n/N ›`). The **×** on the bar turns the highlights off. Highlights are
  only on your screen; nothing is written into the source.

`.bib` files are always read-only for the AI: the model is told so and may read
them, edits it writes for them are never applied, and `Ctrl+K` is turned off in
them. You can still edit them yourself (including `Ctrl+Shift+K`).

Conversations are kept per project on
this computer: **+** starts a new one, **☰** lists the earlier ones to reopen or
delete. Each conversation is its own context; only its messages are sent.

The conversation stays when you switch models: the app keeps it and sends it to
whichever model is selected. A newly selected model has no prompt cache for it,
though, so its first message reads the instructions, the index and the
conversation in full. Switching to a paid model in a conversation that already has
messages therefore asks first, with an estimate of that cost; starting a new chat
(**+**) avoids it.

The model does not receive the whole project. It gets an index in which every
`.tex` file is split into units (sections, subsections, `\paragraph`s, text
paragraphs, figures, tables, algorithms, equations, theorems), each with an id
(`main.tex#12`), a line range and a one-line summary; `.bib` files are listed by
their citation keys. It reads text through tools the app answers from a local copy
of the project (the open file is read live):

- `read_unit(ids)`: exact text of one or several units;
- `read_file(path, lines)`: exact lines;
- `search(text)`: exact text across the project, each hit labelled with its unit;
- `find_related(text)`: units about the same topic even with different wording
  (needs an embedding model, see below);
- `expand(id)`: the units inside a file or unit when the index is shortened;
- `read_history(id)`: an older, summarized part of the conversation.

Changes and search results are tool calls too: in Edit mode the model calls
`propose_edit(file, find, replace)` and in Search mode `mark(file, lines, kind,
note)`. The app checks each one immediately (the text must exist exactly once,
not in a `.bib` file or inside an edit/candidates block; lines must exist) and
tells the model what was wrong, so it can fix the call within the same answer.
Read mode offers neither tool.

**Summaries.** Set a *summary model* in AI Settings (a local model costs nothing).
Summaries are written in the background when a project opens and every two
minutes while it stays open, only for units whose text changed: each unit's
summary is cached by a hash of its text, and a section's summary is built from its
parts' summaries, so an edit re-summarizes that paragraph and the sections above
it. Without a summary model the index shows each unit's first sentence. With a
paid summary model, a first pass larger than the token limit waits for
**Summarize** in the chat panel.

**Long conversations.** The newest messages, up to about 20,000 characters, are
sent as they are. Older ones are grouped into blocks of up to 8,000 characters and
replaced by a short summary (summary model, cached); the model can reopen a block
with `read_history`.

**Related search.** Choose an *embedding model* in AI Settings (for example
`bge-m3` on the local Ollama server, which handles Korean and English). Each unit
is embedded in the background, cached by its content like the summaries;
`find_related` ranks units by meaning plus word overlap. Passages pointed at with
`Ctrl+L` also bring the most related units into the request automatically.

**Efficiency.** The system prompt and the index are kept byte-identical between
requests (the open file, older-conversation summaries and related units travel in
the newest message instead), so Claude's prompt cache covers them across rounds
and questions. Claude uses effort `high` in Edit and Search mode and `low` in Read
mode, and the first request is measured with the token-counting API. OpenAI and
local models stream their answers and tool calls. The project copy is downloaded
again only when Overleaf reports a newer `lastUpdated`. While a chat runs on the
local server, background summarizing on that server waits.

**Token limit.** For Claude and OpenAI, a chat request that has used, or is about
to use, more tokens than the limit in AI Settings (default 200,000) pauses and asks
**Continue** or **Stop**. Local models are not limited.

**Limits.** read_file returns up to 400 lines, read_unit up to 20,000 characters,
search up to 40 matches, read_unit up to 12 units per call; at most 10 lookup
rounds per request; above 60,000
characters the index lists sections only and `expand` opens the rest. Units are
summarized from up to 8,000 characters of their text, 8 per call.

The copy of the project (`files.json`), the summaries (`summaries.json`), older
chat summaries (`history.json`) and a readable `index.md` are kept per project in
the app's data folder under `ai-index/`.

Developer Tools moved from `Ctrl+Shift+I` to `F12`.

## Updates

On startup the app checks the latest published GitHub release; **File → Check for
Updates…** checks on demand. Drafts and pre-releases are ignored.

- Windows installer and AppImage: at startup the update downloads in the
  background, then the app offers to restart. **File → Check for Updates…** goes
  all the way without asking: it downloads (progress on the taskbar icon), installs
  and restarts the app. The Windows installer runs silently and keeps the existing
  install location.
- Windows portable and `.deb`: the app shows a notification with a link to the
  releases page.

## Development

    npm install
    npm start                                  # asks for a server on first run
    npm start -- --server=http://192.168.1.10  # select a server for this run (or set OVERLEAF_URL)

## Building and releasing

    npm run release -- --build-only   # build installers into dist/
    npm run release -- --draft        # build, then upload as a draft GitHub release
    npm run release                   # build and publish

To ship a new version, bump `version` in `package.json`, commit, and run
`npm run release`. The Windows installers need wine, so the script builds them in
Docker (`electronuserland/builder:wine`); uploading needs a logged-in `gh`.

A release must include `latest.yml`, `latest-linux.yml` and the `.blockmap` file
next to the installers, or the updater cannot find the new version.

## Notes

- On Ubuntu 24.04 and later the AppImage may not start without `--no-sandbox`
  because AppArmor restricts user namespaces, and it needs `libfuse2`. The `.deb`
  sets up the sandbox correctly.
