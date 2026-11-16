# Per-mod verdicts: Windows compatibility (grill #6)

## Verdicts

| Mod | Verdict | Requirement / Note |
|-----|---------|--------------------|
| **better-files** | **PORT** | Core target of this map. See `prep/listing.md`, `prep/image-copy.md`, `prep/external-actions.md`. |
| **better-config** | **PORT** | Two POSIX shell-outs need Windows twins (see below). Small, low-risk. |
| **better-changes** | **WORKS AS-IS** | Requires `git` on PATH. All `exec` calls are direct `exec("git", [...])` — no shell, no POSIX assumptions. |
| **better-sidebar** | **WORKS AS-IS** | Requires `git` on PATH. PR status additionally requires `gh` (GitHub CLI) on PATH and authenticated. Already has `window().platform` checks for macOS-specific UI (Cmd vs Ctrl click, sidebar width). |
| **branch-issue** | **WORKS AS-IS** | Requires `git` on PATH + locally built `herdr-linear` Go helper (Windows build). Remote-home probe already has a PowerShell fallback. **Caveat:** the helper's login-shell fallback (`/bin/sh -lic`) for `LINEAR_API_KEY` is POSIX-only; on Windows the user must set `LINEAR_API_KEY` as a system/user environment variable (the `os.Getenv` check comes first, so this is sufficient). |
| **branch-pr** | **WORKS AS-IS** | Requires `git` + `gh` on PATH + locally built `herdr-pr` Go helper (Windows build). Remote-home probe already has a PowerShell fallback. The helper only calls `gh` directly (no shell), so it works on Windows as long as `gh` is installed and on PATH. |
| **better-tabs** | **WORKS AS-IS** | No external commands. Already draws Windows window-control icons (`tab-bar.js:287`). |
| **better-icons** | **WORKS AS-IS** | Pure `herdr` API (`appHome`, `readTextFile`, `watchFolder`). No programs, no shell. |
| **estro** | **WORKS AS-IS** | Layout/pointers only. No runtime code, no shell-outs. |

**Ruled out:** none.

---

## better-config port plan

### Shell-outs to replace

| Call site | Current (macOS) | Windows twin |
|-----------|----------------|--------------|
| `main.js:58` — list installed mod folders | `exec("/bin/sh", ["-c", 'cd "$1" && ls -d */ 2>/dev/null', "sh", appHome + "/mods"])` | `exec("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", "<script>"])` |
| `main.js:112` — create kept-settings folder | `exec("mkdir", ["-p", keptFolder])` | `exec("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", "<script>"])` |

### Listing twin (`main.js:58`)

**Wire contract (unchanged from macOS):** stdout = newline-separated directory names, each with a trailing `/`. JS parser: `stdout.split("\n").map(n => n.replace(/\/$/, "")).filter(Boolean)`.

**PowerShell script (PS 5.1):**
```powershell
$ErrorActionPreference = 'Stop'
$mods = Get-ChildItem -LiteralPath '<appHome>/mods' -Directory
foreach ($d in $mods) { [Console]::Out.Write("$($d.Name)/`n") }
```
- Output: one line per subdirectory, name + trailing `/`, UTF-8.
- No trailing slash on the last line matters — JS parser handles it (`.replace(/\/$/, "")` + `.filter(Boolean)`).
- If the `mods` folder doesn't exist or is empty: script throws → non-zero exit → JS `exec` rejects → same error path as macOS.

**Path embedding:** `appHome()` value is interpolated into the script string. On Windows this will be `C:\Users\<user>\.config\herdr-app` (confirmed by provisioning ticket #4). Use single-quoted PS string for the path; escape any single quotes by doubling (same rule as #7's locked quoting convention). Documented limitation: path containing a literal single quote would break (same class as #7).

### mkdir twin (`main.js:112`)

**PowerShell script (PS 5.1):**
```powershell
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path '<keptFolder>' | Out-Null
```
- `-Force` makes it idempotent (no error if dir already exists), matching `mkdir -p`.
- `keptFolder` = `${home()}/.config/herdr-mods/better-config`. On Windows, `home()` returns the Windows home path (e.g., `C:\Users\Julio`). The mixed separator (`C:\Users\Julio/.config/...`) is acceptable to PowerShell, but the build session should normalize to the platform separator for cleanliness.

### Platform branching

Same pattern as better-files (locked in #5): one new module (e.g., `files/shell.js` equivalent, or inline in `main.js`) that selects the script text and program/args based on `window().platform`. macOS path is byte-for-byte unchanged.

### Box probe block

Paste into Windows PowerShell 5.1 on the UTM box:

```powershell
# 1. Listing twin
$modsPath = Join-Path $env:USERPROFILE '.config\herdr-app\mods'
if (Test-Path -LiteralPath $modsPath) {
    $dirs = Get-ChildItem -LiteralPath $modsPath -Directory
    if ($dirs) {
        foreach ($d in $dirs) { Write-Output "$($d.Name)/" }
    }
    "PASS listing: $($dirs.Count) dirs"
} else {
    "FAIL listing: mods folder not found at $modsPath"
}

# 2. mkdir twin
$testDir = Join-Path $env:TEMP 'wf-mkdir-test\sub'
New-Item -ItemType Directory -Force -Path $testDir | Out-Null
if (Test-Path -LiteralPath $testDir) {
    "PASS mkdir: created $testDir"
    Remove-Item -LiteralPath $testDir -Recurse -Force
} else {
    "FAIL mkdir: dir not created"
}
```

Expected output on a box with mods installed:
```
better-files/
better-changes/
...
PASS listing: N dirs
PASS mkdir: created C:\Users\<user>\AppData\Local\Temp\wf-mkdir-test\sub
```

### Limitations

- Path with a single quote in the username would break the embedded script (same class as #7's documented limitation). Acceptable.
- `Get-ChildItem -Directory` only returns directories (no files), matching `ls -d */` semantics. Symlinks to directories are included (same as `ls -d */`).
- Performance: for a typical number of installed mods (<20), negligible. No cap needed (unlike better-files' 500-entry cap for user file trees).