# Windows Support — Build-Ready Handoff Spec

**Ticket:** #9 (assembles locked decisions from #5, #6, #7, #8)
**Branch:** `windows-drafts`
**Date:** 2026-11-16

## 1. Goal

Build Windows support for this repo's JS mods. This spec is **build-ready**: all design decisions are locked, PowerShell scripts are written and box-verified on a UTM Windows 11 ARM64 box, and verification checklists are defined. **No design work remains.** The build session implements the code changes and runs the checklists.

## 2. Scope

| Category | Mods | Action |
|---|---|---|
| Core port | **better-files** | Port: listing, image copy/cache, external actions |
| Secondary port | **better-config** | Port: 2 POSIX shell-outs |
| Works as-is | better-changes, better-sidebar, branch-issue, branch-pr, better-tabs, better-icons, estro | No code changes (see §7) |

**Out of scope:** upstreaming to munza/herdr-mods; Sheprd Luau mod system; remote mixed-OS spaces (a space on a machine whose OS differs from the local app's is explicitly unsupported — the spec assumes each machine reports its own OS correctly).

## 3. Architecture: Platform Branching

### 3.1 The seam

One new module per mod that has shell-outs (e.g., `files/shell.js` for better-files, inline or a small module for better-config) containing:

- The macOS sh script texts (moved verbatim from current call sites).
- The Windows PowerShell 5.1 script texts.
- A selection function that returns `{ program, args }` based on `window().platform`.

All existing call sites route through this module. **No scattered `if (windows)` checks.** macOS code path is byte-for-byte unchanged.

### 3.2 PowerShell invocation shape (LOCKED, box-verified)

```
program:  powershell.exe
args:     ["-NoProfile", "-NoLogo", "-Command", <scriptString>]
```

- **Script with arguments** (REQUIRED on PS 5.1): `& { <script body> } '<arg1>' '<arg2>' …`
  - The `& { … } '<arg>'` scriptblock wrapper is **mandatory** on PowerShell 5.1 because bare `-Command <script> <arg>` appends the arg into the command text instead of binding `$args`. Fixed in pwsh 7, but the target is 5.1.
- **Script without arguments:** bare `-Command <script>` is fine.
- **Path quoting:** single-quoted; embedded `'` doubled. JS helper: `psQuote(s) = "'" + s.replace(/'/g, "''") + "'"`.
- **No cmd, no pwsh-7 dependency.** PowerShell 5.1 is built into every Windows 10/11.

### 3.3 Platform detection

`window().platform` returns `"windows"` on Windows, `"darwin"` on macOS. First-class API; already used by better-sidebar and branch-issue/branch-pr.

## 4. better-files Change List

### 4.1 File listing (`files/reads.js`)

**Current (macOS):** `exec("sh", ["-c", <sh script>, "files", path])` — `n=0; for p in "$1"/* …; do … printf "%s\0%s\0" …`

**New:** Route through the shell.js seam.

| Platform | Script |
|---|---|
| macOS | Unchanged sh script, byte-for-byte. |
| Windows | PowerShell 5.1: `Get-ChildItem -LiteralPath $p -Force \| Where-Object { $_.Name -ne '.git' } \| Select-Object -First 500 \| ForEach-Object { … [Console]::Out.Write($k + [char]0 + $_.Name + [char]0) }` |

**Wire contract (unchanged from macOS):**
- stdout: `kind\0name\0` NUL-delimited pairs. `kind` = `d` (directory) or `f` (file).
- `.git` directory excluded.
- 500-entry cap (exact — the PowerShell twin enforces exactly 500 via `Select-Object -First 500`; the sh script checks `n > 500` after printing, so it can emit 501; this is a deliberate improvement).
- UTF-8 output (`[Console]::OutputEncoding = [Text.Encoding]::UTF8`).
- Missing folder: exit 1, diagnostic on stderr (`Cannot list this folder.`). JS parser throws `r.stderr || "Cannot list this folder."`.
- Empty folder: exit 0, empty stdout.

**Full PS script:** See `prep/listing.md` §2.
**Golden output (od -c):** See `prep/listing.md` §3.
**Box test block:** See `prep/listing.md` §4.
**Verification status:** Box-verified 2026-11-16 (UTM Win11 ARM, PS 5.1). All checks pass: NUL pairs intact, UTF-8 round-trip, dotfiles included, `.git` excluded, exact-500 cap (512→500), missing folder → exit 1 + stderr, exit 0 on success.

### 4.2 Image copy + cache cleanup

**COPY_IMAGE** (`views/viewer.js:385,450`):

| Platform | Script |
|---|---|
| macOS | Unchanged: `[ -z "$3" ] \|\| rm -f -- "$3"; mkdir -p -- "$(dirname -- "$2")" && { cmp -s -- "$1" "$2" \|\| cp -- "$1" "$2"; }` |
| Windows | PowerShell: delete old (if non-empty) → `New-Item -Force` parent → `Test-Path` source (exit 1 if missing) → compare via `Get-FileHash -Algorithm SHA256` → `Copy-Item` only if different → exit 0. |

**Deliberate deviation:** SHA-256 hash comparison instead of `cmp -s` (no byte-compare builtin in PS 5.1). Collision risk negligible; the check's job is skipping redundant copies of the mod's own cache files.

**Cache cleanup** (`main.js:109`):

| Platform | Script |
|---|---|
| macOS | Unchanged: `exec("rm", ["-f", "--", ...paths])` |
| Windows | PowerShell: `foreach($p in $args){Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue}; exit 0` — always exits 0, mirroring the JS `.catch(() => {})`. |

**Full PS scripts:** See `prep/image-copy.md` §2–3.
**Semantics table (6 scenarios with observed states):** See `prep/image-copy.md` §1.
**Box test block:** See `prep/image-copy.md` §4.
**Verification status:** Box-verified 2026-11-16. All 7 checks pass: fresh copy, changed-source replace, identical-source skip (mtime preserved), old-copy deletion, empty-old no-op, missing-source failure (exit 1, no dest), cleanup (removes existing, ignores absent, exit 0).

### 4.3 External actions (`actions/outside.js`, `files/model.js`, `views/context-menu.js`)

**Editor list:** Five of six ship on Windows. **Nova dropped** (macOS-only).

| Name | Windows executable |
|---|---|
| Zed | `Zed.exe` |
| VS Code | `Code.exe` |
| Cursor | `Cursor.exe` |
| Windsurf | `Windsurf.exe` |
| Sublime Text | `sublime_text.exe` |

**Detection** (replaces per-bundle `mdfind`):

One PowerShell 5.1 process for all candidates (candidate table embedded in script text). For each executable, three sources checked in order, **first hit wins**:

1. **App Paths registry:** `HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>` then `HKCU:` (per-user installs). Default value = resolved full exe path.
2. **PATH scan:** first `$env:PATH` directory containing the executable.
3. **Well-known directories:**

| Exe | Known directories |
|---|---|
| `Zed.exe` | `%LOCALAPPDATA%\Programs\Zed` |
| `Code.exe` | `%LOCALAPPDATA%\Programs\Microsoft VS Code`, `%ProgramFiles%\Microsoft VS Code` |
| `Cursor.exe` | `%LOCALAPPDATA%\Programs\cursor` |
| `Windsurf.exe` | `%LOCALAPPDATA%\Programs\Windsurf` |
| `sublime_text.exe` | `%ProgramFiles%\Sublime Text`, `%ProgramFiles(x86)\Sublime Text` |

**Wire contract:** found editors emitted as `name\0exe\0` pairs on stdout (UTF-8, NUL convention same as listing). Only hits. Exit code always 0. JS parses into `{ name, exe }` shared entries storing the **resolved full path** (not bare name).

**Launch twins:**

| Action | macOS (unchanged) | Windows twin |
|---|---|---|
| `openInEditor` | `open -b <bundle> <path>` | `Start-Process -FilePath '<exe>' -ArgumentList @('<path>')` |
| `openWithDefault` | `open <path>` | `Invoke-Item -LiteralPath '<path>'` |
| `revealInFinder` | `open -R <path>` | `explorer.exe /select,"<path>"` (single arg; inner double quotes) |

**Menu changes:**
- `Show in Finder` → `Show in Explorer` on Windows.
- Error text: `show it in Finder` → `show in Explorer`.
- Menu item id: `editor-${e.bundle}` → `editor-${e.exe}` on Windows.
- Only detected editors appear in the menu (same behavior as macOS `mdfind`).

**`settings.editors` extra field:** takes executable names on Windows (macOS: app bundle IDs). Probed the same way.

**Full PS scripts + detection matrix:** See `prep/external-actions.md`.
**Box probe block:** See `prep/external-actions.md` §"Box probe block".
**Verification status:** Mechanics box-verified 2026-11-16 (fixture-with-spaces PASS, `& {…}` wrapper PASS, matrix runs clean all-empty, cleanup PASS). **Positive detection + launch path unverified** (no editor on box; optional VS Code install skipped). Residual risk mitigated: all three detection sources kept with first-hit-wins, so a wrong known-dir guess only loses one fallback.

### 4.4 Git change marks

**No twin needed.** `git` is the same binary on both platforms. Already silent when git is absent. The `git status --porcelain` and `git diff` calls are direct `exec("git", [...])` — no shell, no POSIX assumptions.

## 5. better-config Change List

Two POSIX shell-outs to replace (small, low-risk):

| Call site | Current (macOS) | Windows twin |
|---|---|---|
| `main.js:58` — list mod folders | `exec("/bin/sh", ["-c", 'cd "$1" && ls -d */ 2>/dev/null', "sh", appHome + "/mods"])` | PowerShell: `Get-ChildItem -LiteralPath '<path>' -Directory \| ForEach-Object { [Console]::Out.Write("$($_.Name)/`n") }` |
| `main.js:112` — create folder | `exec("mkdir", ["-p", keptFolder])` | PowerShell: `New-Item -ItemType Directory -Force -Path '<path>' \| Out-Null` |

**Wire contracts:**
- Listing: stdout = newline-separated directory names, each with trailing `/`. JS parser: `stdout.split("\n").map(n => n.replace(/\/$/, "")).filter(Boolean)`.
- mkdir: `-Force` = idempotent (no error if exists), matching `mkdir -p`.

**Full PS scripts + box probe:** See `prep/per-mod-verdicts.md` §"better-config port plan".

## 6. better-changes / better-sidebar / branch-issue / branch-pr

**Work as-is.** All `exec` calls are direct (`exec("git", [...])`, `exec("gh", [...])`) — no shell, no POSIX assumptions. Requirements: `git` on PATH; better-sidebar and branch-pr additionally need `gh` (GitHub CLI) on PATH and authenticated; branch-issue/branch-pr need locally built Go helpers (`herdr-linear`, `herdr-pr`) compiled for Windows.

**Caveat (branch-issue):** the helper's login-shell fallback (`/bin/sh -lic`) for `LINEAR_API_KEY` is POSIX-only. On Windows the user must set `LINEAR_API_KEY` as a system/user environment variable (the `os.Getenv` check comes first, so this is sufficient).

## 7. Per-mod verdicts (summary)

| Mod | Verdict | Requirement |
|---|---|---|
| better-files | **PORT** | This spec, §4 |
| better-config | **PORT** | §5 above |
| better-changes | WORKS AS-IS | `git` on PATH |
| better-sidebar | WORKS AS-IS | `git` + `gh` on PATH, authenticated |
| branch-issue | WORKS AS-IS | `git` + `herdr-linear` (Win build) + `LINEAR_API_KEY` env var |
| branch-pr | WORKS AS-IS | `git` + `gh` + `herdr-pr` (Win build) |
| better-tabs | WORKS AS-IS | None (already draws Win window-control icons) |
| better-icons | WORKS AS-IS | None (pure `herdr` API) |
| estro | WORKS AS-IS | None (layout/pointers only) |

## 8. Smoke Protocol (S1–S7)

**Purpose:** Seven end-to-end behaviors that must be demonstrably working on the UTM box after the mod is built. This is the minimum bar for the mod to be considered working on Windows.

| # | Check | What to observe | Pass criterion |
|---|---|---|---|
| S1 | Tree loads | Open better-files on a local folder | Sidebar shows folder tree, correct names/types, no error banner |
| S2 | Text file opens | Click a `.md` or `.txt` file | Viewer shows content, syntax-highlighted |
| S3 | Markdown renders | Click a `.md` with headings, code fences, image ref | Rendered Markdown, image resolved |
| S4 | Image file opens | Click a `.png` or `.jpg` | Viewer shows image; cache copy exists under `appHome()` |
| S5 | Change marks show | In git repo, modify a file | Tree shows change mark on modified file |
| S6 | Send-to-agent | Right-click → "Send to agent" | Path/content appears in agent context |
| S7 | Open in editor | Right-click → "Open in \<Editor\>" | Editor launches with file open |

**Prerequisites:** S5 needs git (confirmed: git 2.56.0 on box). S6 needs at least one agent configured. S7 needs at least one editor installed — if none, S7 is **SKIPPED (no editor)** and does not block.

**Execution:** Manual UI walkthrough in the Herdr app on the box. PowerShell pre-flight block verifies fixtures exist. See `prep/verification.md` §3.

**Reporting format:**
```
PASS  S1 tree loads
PASS  S2 text file opens
…
SKIPPED S6 send-to-agent (no agent configured on box)
PASS  S7 open in editor (VS Code)
```

## 9. Full Verification Checklist (B1–B10)

Comprehensive build-session verification. All items must be addressed (pass, fail-with-workaround, or documented limitation) before production-ready. Organized by subsystem:

- **B1.1–B1.3:** Platform branching (platform value, macOS unchanged, single branch point)
- **B2.1–B2.9:** File listing (NUL pairs, UTF-8, dotfiles, `.git` excluded, 500 cap, missing folder, empty folder, long path, UNC)
- **B3.1–B3.6:** File viewing (text, markdown, 400k cap, binary, deleted file, non-ASCII filename)
- **B4.1–B4.7:** Image display + cache (open, cache hit, modified source, tab close cleanup, markdown images, subfolder, mkdir)
- **B5.1–B5.5:** Git integration (status marks, diff view, git absent, clean repo, many changes)
- **B6.1–B6.8:** External actions (detection, launch, default app, explorer, absent editor, launch failure, spaces, special chars)
- **B7.1–B7.5:** Refresh and file watching (add, delete, rename, folder, CPU)
- **B8.1–B8.4:** Tab and space semantics (shared tab, keep tab, close cleanup, multiple tabs)
- **B9.1–B9.5:** Error handling (exec rejection, error state, treeError, concurrency, restart)
- **B10.1–B10.7:** Windows edge cases (drive letters, spaces, single quote, double quote, long path, appHome, mixed separators)

**Full table with methods:** See `prep/verification.md` §4.

## 10. Test Box State

**Box:** Windows 11 ARM64 in UTM on Apple Silicon Mac.

**Installed (verified):**
| Component | Version | Notes |
|---|---|---|
| Herdr app | 0.1.16 | Manual tarball install (x86_64 under emulation); one-line installer refuses ARM64 |
| herdr-core | 0.1.21 | Installed via app's first-launch offer (no PowerShell gate) |
| git | 2.56.0.windows.4 | Winget, native ARM64 |
| gh | 2.104.0 | Winget, native ARM64 |
| Windows PowerShell | 5.1 | Built-in |
| PowerShell | 7.7.0 | Winget (for side-by-side testing) |

**`appHome`:** `C:\Users\Julio\.config\herdr-app` (same `.config/herdr-app` convention as macOS). Contains `AGENTS.md`, `herdr.d.ts`, `mods/`.

**Gotchas:**
- Shipped `main.json` is read-only to the app; user edits migrate to `main-edited`.
- Registry PATH writes don't reach already-running terminals; new tabs may inherit stale PATH.
- `latest.json` is served as `application/json`; `irm | ConvertFrom-Json` stringifies and fails — installer works around this with `Get-Content -Raw`.
- `exec("rm", …)` result on Windows not recorded in box record; the observed program-not-found failure is `'herdr-exec': cannot run sh: program not found`.

**Full details:** See `prep/install-env.md`.

## 11. Documented Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| Path with literal single quote | Breaks embedded PS script (quoting) | Documented; same class as macOS `sh -c` quoting |
| Path with literal `"` in reveal | Breaks `explorer /select,"…"` argument | Documented; rare; no workaround chosen |
| Store/UWP editor installs | Not detectable (no App Paths/PATH entry) | No menu item shown; acceptable |
| `Start-Process` is async | Exit 0 = process started, not app confirmed open | Same observability class as macOS `open` |
| SHA-256 hash vs `cmp -s` | Not literal byte equality | Collision risk negligible; mod's own cache files |
| Long paths >260 chars | Undocumented PS behavior | Checklist item B2.8/B10.5; record what happens |
| UNC paths | May not be feasible on isolated box | B2.9: mark SKIPPED if no share available |
| Remote mixed-OS spaces | Explicitly out of scope | Waived to develop; not supported as use case |
| Positive editor detection | Unverified on clean box (no editor installed) | All three sources kept with first-hit-wins |

## 12. Source Documents (on `windows-drafts` branch, `prep/`)

| File | Content |
|---|---|
| `prep/listing.md` | Listing wire contract, PS script, golden output (od -c), box test block |
| `prep/image-copy.md` | COPY_IMAGE + cleanup semantics table, PS scripts, box test block (7 checks) |
| `prep/external-actions.md` | Detection + launch design, PS scripts, box probe block, limits |
| `prep/per-mod-verdicts.md` | Per-mod verdicts, better-config port plan + PS scripts + box probe |
| `prep/verification.md` | Smoke protocol (S1–S7), full B* checklist (44 items), reporting format |
| `prep/install-env.md` | Box install steps, environment, gotchas, provenance |
| `prep/windows-sandbox-macos.md` | VM comparison (UTM vs Parallels vs VirtualBox vs QEMU), provisioning guidance |

## 13. Build Session Entry Point

1. Check out `windows-drafts`.
2. Read this spec (this file).
3. Implement better-files changes (§4) — start with `files/shell.js` seam, then listing, then image copy, then external actions.
4. Implement better-config changes (§5).
5. Run smoke protocol (§8) on the UTM box.
6. Run full checklist (§9) on the UTM box.
7. Report results; address failures.
8. All S1–S7 pass (or documented SKIPPED) + all B* addressed = production-ready.