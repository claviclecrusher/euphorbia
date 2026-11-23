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
