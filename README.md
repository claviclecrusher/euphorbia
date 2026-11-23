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

Sign-in flows that pass through another site (Google, ORCID, institutional SSO)
stay inside the app window when they start from a login page. Any other link that
leaves the server opens in the system browser.

Google refuses sign-in from embedded browsers, so "Log in with Google" on
overleaf.com does not complete inside the app, and a session created in the system
browser cannot be passed to the app. The app explains this when you click the
Google button: set a password for the Overleaf account and sign in with email and
password instead.

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
