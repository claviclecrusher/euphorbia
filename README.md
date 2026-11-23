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

Every document you open in a project gets a tab above the editor. Click a tab to
switch to it, `×` or a middle click to close it, and drag tabs to reorder them.
Tabs are remembered per project on this computer. Overleaf still edits one
document at a time; switching a tab opens that document as if it had been clicked
in the file tree, including inside collapsed folders.

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

The new text is what compiles; the old text is kept in the source as comments:

    %%edit:begin by="Alice Kim" at="2026-11-23 14:05"
    %- We propose a method.
    %%edit:new
    We propose a novel method.
    %%edit:end

Developer Tools moved from `Ctrl+Shift+I` to `F12`.

## Updates

On startup the app checks the latest published GitHub release; **File → Check for
Updates…** checks on demand. Drafts and pre-releases are ignored.

- Windows installer and AppImage: the update downloads in the background, then the
  app offers to restart. The Windows installer runs silently and keeps the existing
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
