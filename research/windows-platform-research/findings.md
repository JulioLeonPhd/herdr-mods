# Windows platform research: Herdr JS mod runtime + per-mod inventory

Findings for [Map: core-first Windows support for the mods](https://github.com/JulioLeonPhd/herdr-mods/issues/1) — resolves
[Research: what the mod runtime permits on Windows](https://github.com/JulioLeonPhd/herdr-mods/issues/2) and
[Research: per-mod inventory of shell-outs and macOS-only features](https://github.com/JulioLeonPhd/herdr-mods/issues/3).

Read-only investigation of `/Users/julio/projects/forks/herdr-mods` plus the in-app mod docs
(`~/.config/herdr-app/AGENTS.md`, `~/.config/herdr-app/herdr.d.ts`) on the dev Mac.
Throwaway branch: never merged. Not checked: builds, tests, or Windows execution.

## Mod platform

- The in-app docs exist at `~/.config/herdr-app/AGENTS.md`; that file says mods cannot use "Node APIs" and identifies `herdr.d.ts` as the truth for app commands and data. (`~/.config/herdr-app/AGENTS.md:30-40`)
- **Pure-JS file operations:** Node `fs`/`path` are not permitted in mods. The documented `herdr` APIs do provide UTF-8 text reads and conditional atomic writes, plus folder watching; they do **not** document general directory listing, copy, or delete APIs. Those operations therefore need an available Herdr API or a program call. (`~/.config/herdr-app/AGENTS.md:30-40`; `~/.config/herdr-app/herdr.d.ts:24-29,415-421`)
- **Imported `herdr` members, as documented:**
  - `exec` runs a program with the user's environment; accepts `cwd`, `on`, and timeout; rejects if it cannot start. (`herdr.d.ts:10-14`)
  - `hc` runs `hc` with given arguments. (`herdr.d.ts:16-17`)
  - `home` returns the user's home directory; `appHome` returns the app folder, documented as `~/.config/herdr-app` or `$HERDR_APP_HOME`. No distinct macOS/Windows values are documented. (`herdr.d.ts:19-22`)
  - `readTextFile` reads up to 1 MiB of UTF-8, returns `null` if absent, and can read on a space's machine; `writeTextFile` writes only against the expected snapshot and replaces atomically. (`herdr.d.ts:24-29`)
  - `watchFolder` waits for file changes and returns absolute paths in batches; docs explicitly say macOS and Windows watch recursively. (`herdr.d.ts:415-421`)
  - `knownAgents` lists menu agents and whether installed, checking the shell on the selected machine; rejects on check failure. (`herdr.d.ts:31-35`)
  - `spaces` returns ordered spaces and re-renders mods when they change; `machines` reports machine layout availability. (`herdr.d.ts:134-139`)
  - `panes` returns panes; `focused` reports actual pane/terminal focus and cwd; `agents` returns status-reporting terminals. (`herdr.d.ts:183-209,230-234`)
  - `window` reports platform (`linux`, `macos`, `windows`) and window state. (`herdr.d.ts:250-260`)
  - `shared` reads persisted values visible to mods; `setShared` updates one and re-renders mods. (`herdr.d.ts:397-400`)
  - Other imported members include `run` (runs a Herdr command), `layout` (shown layout), `theme` (theme colors), `settings` (effective app settings), `props` (this mod copy's props), `nextCommand` (waits for this mod's next key command), `setAgentOrder`, `updates`, `openOverlay`, `closeOverlay`, and `notify`. (`herdr.d.ts:39-80,238-240,275-277,292-334,371-400`)
- **Shell vs. binary:** Docs say `exec` "Runs a program" with a command and argument array; they do not explicitly say "no shell." **INFERRED:** it launches the named program with arguments directly, not via an implicit shell; explicit `sh -c` call sites below demonstrate shell use is opt-in. An unknown/unstartable binary rejects the promise; docs give no error-object shape. (`herdr.d.ts:10-14`)
- `{ on }` runs/reads on the named space machine through `herdr-core`; omitted/null means this computer, and remote execution uses that machine's home. (`herdr.d.ts:10-14,24-26`)
- Windows notes in the docs: `window().platform` is `"windows"`; system window buttons are absent and layouts may draw them; folder watching is recursive. No OS-specific `appHome()` value is documented. (`herdr.d.ts:250-260,415-421`; `AGENTS.md:251-263`)

## Per-mod verdicts

- **better-changes — NEEDS-SHELL-OUT-CHANGES.** Runtime external command: `git`, via `repository.js:63`, for repository status, diffs, staging/commits and history. No `sh -c`, platform checks, or macOS-only feature found in runtime code. Git is the only runtime executable.
- **better-config — NEEDS-SHELL-OUT-CHANGES.** `/bin/sh` with `-c` runs `cd "$1" && ls -d */ 2>/dev/null` to list installed mod folders (`main.js:58`); `mkdir -p` creates its saved-settings directory (`main.js:112`). POSIX shell, glob and path assumptions are at `main.js:58,112`. No platform checks or macOS-only feature found.
- **better-files — NEEDS-MACOS-EXTRAS-PORT** (also requires shell-out changes).
  - External commands: `sh` at `files/reads.js:10` lists entries; `git` at `files/reads.js:87-96` and `views/viewer.js:101` reads repository status/diffs; `rm` at `main.js:109` deletes cached image copies; `mdfind` at `actions/outside.js:18-20` discovers editor bundle IDs; `open` at `actions/outside.js:57` opens files/editors or reveals them in Finder.
  - `sh -c` calls: `files/reads.js:10` runs the directory-listing loop; `views/viewer.js:385,450` run `COPY_IMAGE` (`viewer.js:33`), which removes the old cache entry, creates its parent, compares source/destination, then copies the image.
  - Platform check: `actions/outside.js:14` skips editor discovery on Windows.
  - macOS-specific extras: Spotlight `mdfind`, editor bundle IDs, `open -b`, default-app opening, and Finder reveal/menu (`actions/outside.js:18-20,57-71`; `RECIPE.md:7,15,29`; `README.md:26,44`). The Windows guard only skips editor discovery; opening/reveal calls still use `open`. README explicitly says directory listing needs `sh` and fails on Windows. (`README.md:44,73`)
- **better-icons — PORTABLE-AS-IS.** No runtime external commands or platform checks found; `RECIPE.md:34` says it runs no programs. Its file-icon resolver uses Herdr `appHome`, `readTextFile`, and `watchFolder`. ( `mods/better-icons/file-icons.js:4`; `RECIPE.md:26,34`)
- **better-sidebar — NEEDS-SHELL-OUT-CHANGES.** External commands: `git` reads checkout/status/branch/worktree metadata (`git/checkouts.js:21-33`; `git/pr-status.js:108`); `gh` queries PR status (`git/pr-status.js:186`). `hc machine ls --json` is called through the Herdr `hc` API (`views/spaces.js:212`). Platform checks: `views/agents.js:35` adjusts sidebar width for macOS; `views/spaces.js:519,526` select Cmd-click on macOS and Ctrl-click otherwise. No `sh -c` or macOS-only shell/path feature found.
- **better-tabs — PORTABLE-AS-IS.** No external commands. Platform checks use Herdr's `window()` API: `views/tab-bar.js:150` reserves macOS traffic-light space; `:287` selects Windows window-control icons. No OS-specific shell or path assumption found.
- **branch-issue — NEEDS-SHELL-OUT-CHANGES.** External commands: `git` reads/writes branch config, fetches and creates worktrees (`actions/worktrees.js:17-29,86-96,113-114,148,194-202`; `linear/discovery.js:79,133-163`); `powershell.exe` is the remote-home fallback (`actions/worktrees.js:209-214`); `herdr-linear` is run by `exec` to call Linear (`linear/reads.js:11-16`). The helper also invokes the login shell (`helper/main.go:72-84`) to retrieve `LINEAR_API_KEY` when it is absent from the environment. `sh -c` at `actions/worktrees.js:209` prints the remote home; PowerShell is the fallback. No platform checks or macOS-only features found.
- **branch-pr — NEEDS-SHELL-OUT-CHANGES.** External commands: `git` handles GitHub remote/branch/worktree operations (`github/discovery.js:60-65,102,165-170`; `actions/worktrees.js:20-33,121,144`); `powershell.exe` is the remote-home fallback (`actions/worktrees.js:155-160`); `herdr-pr` is run by `exec` to call GitHub (`github/reads.js:35-44`), and its helper invokes `gh` (`helper/main.go:64`). `sh -c` at `actions/worktrees.js:155` prints the remote home; PowerShell is the fallback. No platform checks or macOS-only features found.
- **estro — PORTABLE-AS-IS.** Layout/pointers only; no mod runtime commands or platform checks found. Its recipe says to install the referenced mods separately. (`RECIPE.md:32-40,46`)

## Install flow

- Each mod's `README.md` has an install prompt pointing to the GitHub mod folder; prompts say to read `~/.config/herdr-app/AGENTS.md` first (for example `better-files/README.md:40-42`; the same pattern is in the other seven mod READMEs). The GitHub install intent is platform-neutral; the literal `~/.config/...` doc path is POSIX-style, and Herdr docs do not document its Windows location. (`herdr.d.ts:21-22`)
- `better-files/RECIPE.md:29` explicitly requires `mdfind` and `open -b`; its README additionally documents the `sh` Windows failure (`README.md:44,73`).
- `better-config/RECIPE.md:15,19` refers to `~/.config/herdr-app/mods/` and `~/.config/herdr-mods/...`; its runtime additionally relies on `/bin/sh`, POSIX globbing and `mkdir -p` (`mods/better-config/main.js:58,112`).
- `branch-issue/RECIPE.md:41-45` and `branch-pr/RECIPE.md:45-49` describe locally built Go helpers and remote Git operations; each says its helper stays local. The recipes do not prescribe a shell-based copy/install command in those sections.
- `estro/RECIPE.md:30-40` says to copy only `layouts/estro.json`, then add mods from their prompts; it says not to copy the `mods/` pointers.
- Six top-level mods have `sync.sh`: better-changes, better-config, better-files, better-icons, better-sidebar and better-tabs. Each uses `#!/bin/sh`, `cd`, `rsync -a --delete`, `$HOME`, and POSIX-style paths to copy the runtime folder into Herdr's mod directory; these sync scripts presume a POSIX shell and `rsync`. (Each `*/sync.sh:1-3`.) No top-level `sync.sh` was found for branch-issue, branch-pr or estro.
