# External actions: Windows draft (grill #7)

## Inventory

| macOS-only surface | Current behavior | Windows behavior today |
|---|---|---|
| `mdfind` Spotlight detection (`outside.js:18`) | Runs one Spotlight `mdfind` lookup for each editor bundle ID in a detection run and publishes matches in shared `better-files.editors`. | `findEditors` returns before spawning or updating shared state. `foundEditors()` returns the existing value or `[]`; editor-specific entries use that list, so a fresh Windows state has none (existing shared state can remain stale). |
| `open -b <bundle>` (`openInEditor`) | Opens the file using a macOS application bundle ID. | There are no editor entries from a fresh Windows state. If invoked, the action still calls `open`; failure sets shared `better-files.error`, which the sidebar renders as a message. |
| `open <path>` (`openWithDefault`) | Opens a local file in its default application. | “Open in default app” is still added for a local non-directory file; invoking it still calls `open`. Failure sets shared `better-files.error`, rendered as a sidebar message. |
| `open -R <path>` (`revealInFinder`) | Reveals the path in Finder. | “Show in Finder” is still added for a local target; invoking it still calls `open`. Failure sets shared `better-files.error`, rendered as a sidebar message. |

Exact source lines establishing the current behavior:

```js
// outside.js:6-7
const FOUND = "better-files.editors";
const ERROR = "better-files.error";
// outside.js:9-9
export const foundEditors = () => shared(FOUND) ?? [];
// outside.js:13-27
findEditors(cx, extra = []) {
  if (window()?.platform === "windows") return;
  cx.spawn(async (cx) => {
    const found = [];
    for (const editor of [...EDITORS, ...extra]) {
      const r = await exec(
        "mdfind",
        [`kMDItemCFBundleIdentifier == '${String(editor.bundle).replace(/'/g, "")}'`],
        {},
      ).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) found.push(editor);
    }
    setShared(FOUND, found);
    cx.notify();
  });
},
// outside.js:56-73
async outside(args, what) {
  const r = await exec("open", args, {}).catch((e) => ({ code: 1, stderr: String(e) }));
  if (r.code !== 0) setShared(ERROR, `Could not ${what}: ${r.stderr?.trim() || "it failed"}`);
  else setShared(ERROR, null);
},
openInEditor(editor, path) {
  return this.outside(["-b", editor.bundle, path], `open it in ${editor.name}`);
},
openWithDefault(path) {
  return this.outside([path], "open it");
},
revealInFinder(path) {
  return this.outside(["-R", path], "show it in Finder");
},
```

```js
// context-menu.js:20-32
groups.push([
  ...editors.map((e) => ({
    id: `editor-${e.bundle}`,
    label: `Open in ${e.name}`,
    run: () => this.openInEditor(e, target.path),
  })),
  ...(local && !target.dir
    ? [{ id: "default", label: "Open in default app", run: () => this.openWithDefault(target.path) }]
    : []),
  ...(local
    ? [{ id: "reveal", label: "Show in Finder", run: () => this.revealInFinder(target.path) }]
    : []),
]);
```

```js
// files/model.js:8-15
export const EDITORS = [
  { name: "Zed", bundle: "dev.zed.Zed" },
  { name: "VS Code", bundle: "com.microsoft.VSCode" },
  { name: "Cursor", bundle: "com.todesktop.230313mzl4w4u92" },
  { name: "Windsurf", bundle: "com.exafunction.windsurf" },
  { name: "Sublime Text", bundle: "com.sublimetext.4" },
  { name: "Nova", bundle: "com.panic.Nova" },
];
```

Git change marks need no twin; they come from git status/diff data, not these macOS commands.

## Resolved design (2026-11-16)

One platform branch in `actions/outside.js` on `window().platform`; macOS keeps `mdfind`/`open` byte-for-byte. Every Windows call is Windows PowerShell 5.1 `-NoProfile -NoLogo -Command` (no cmd, no pwsh-7 dependency, per #5).

| Action | macOS (today) | Windows twin |
|---|---|---|
| Detect editors | one `mdfind kMDItemCFBundleIdentifier == '…'` per bundle | one PowerShell 5.1 process for all candidates |
| `openInEditor` | `open -b <bundle> <path>` | `Start-Process -FilePath '<exe>' -ArgumentList @('<path>')` |
| `openWithDefault` | `open <path>` | `Invoke-Item -LiteralPath '<path>'` |
| `revealInFinder` | `open -R <path>` | `explorer.exe /select,"<path>"` (single argument) |

### Editor list on Windows

Five of the six ship on Windows; **Nova is dropped** — it is macOS-only and can never be detected there.

| EDITORS name | Windows executable |
|---|---|
| Zed | `Zed.exe` |
| VS Code | `Code.exe` |
| Cursor | `Cursor.exe` |
| Windsurf | `Windsurf.exe` |
| Sublime Text | `sublime_text.exe` |

The `settings.editors` extra field takes **executable names** on Windows (macOS: app IDs) and is probed the same way. The menu shows only detected editors — same as macOS with mdfind; undetected means no menu item and no error.

### Detection: one process, three sources, first hit wins

macOS runs one `mdfind` per editor; the Windows twin runs **one** PowerShell process for all candidates (the candidate table is embedded in the script text — trailing `-Command` arguments are not usable on 5.1, see invocation shape). For each candidate executable, in order:

1. **App Paths registry**: `HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>` then the same key under `HKCU` — per-user installs (VS Code tarball, Zed) register in HKCU. The registry default value is the resolved full executable path.
2. **PATH scan**: first directory of `$env:PATH` containing the executable.
3. **Well-known install directories** (guessed table; the box matrix decides which source is authoritative per editor):

| Exe | Known directories |
|---|---|
| `Zed.exe` | `%LOCALAPPDATA%\Programs\Zed` |
| `Code.exe` | `%LOCALAPPDATA%\Programs\Microsoft VS Code`, `%ProgramFiles%\Microsoft VS Code` |
| `Cursor.exe` | `%LOCALAPPDATA%\Programs\cursor` |
| `Windsurf.exe` | `%LOCALAPPDATA%\Programs\Windsurf` |
| `sublime_text.exe` | `%ProgramFiles%\Sublime Text`, `%ProgramFiles(x86)\Sublime Text` |

Wire contract: found editors are emitted as `name\0exe\0` pairs on stdout (UTF-8, `[Console]::Out.Write`, same NUL convention as the listing twin), only hits, exit code always 0. `findEditors` drops the Windows early return and parses the pairs into `{ name, exe }` shared entries (the resolved **full path**, not a bare name — `openInEditor` launches the stored path).

### Invocation shape (locked in #5, box-verified 2026-11-16)

Windows PowerShell 5.1 appends trailing `-Command` arguments to the command text instead of binding them to `$args`, so every call with arguments embeds them in a single `-Command` string as a scriptblock call, paths single-quoted (embedded `'` doubled):

- Detect (no arguments — a bare `-Command <script>` is fine, the candidate table is embedded in the script text)
- `openInEditor`: `& { Start-Process -FilePath $args[0] -ArgumentList @($args[1]) } '<exe>' '<path>'`
- `openWithDefault`: `& { Invoke-Item -LiteralPath $args[0] } '<path>'`
- reveal: `& { Start-Process -FilePath 'explorer.exe' -ArgumentList @('/select,"' + $args[0] + '"') } '<path>'` — the inner double quotes make `/select,"<path>"` one argument; a literal `"` in the path breaks it (documented limit).

### Menu labels, ids, errors

- Menu label `Show in Finder` → `Show in Explorer` on Windows; error text `show it in Finder` → `show in Explorer` (the `what` strings are platform-dependent).
- Menu item id `editor-${e.bundle}` → `editor-${e.exe}` on Windows.
- No items are hidden beyond what detection naturally hides: “Open in default app” and reveal get real twins. Launch failures keep flowing through the existing `better-files.error` shared path (`Could not <what>: <stderr or it failed>`); no new UI.

## Box probe block

Paste once into Windows PowerShell 5.1 on the UTM box. It checks (1) a fixture with spaces in the path, (2) the seam wrapper `& { … } '<arg>'` with that spaced path as a dry run — proves quoting without launching any app, (3) the per-source detection matrix for the five candidate executables, and (4) removes the fixture. On a clean box the matrix is expected to be all-empty.

```powershell
$ErrorActionPreference = 'Stop'
# 1. fixture with spaces
$fixture = Join-Path $env:TEMP ('bf-probe-' + [guid]::NewGuid().ToString('N'))
$spaced = Join-Path $fixture 'dir with space'
New-Item -ItemType Directory -Path $spaced | Out-Null
$file = Join-Path $spaced 'my file.txt'
Set-Content -LiteralPath $file -Value 'probe'
'fixture(spaces): ' + $(if (Test-Path -LiteralPath $file) { 'PASS' } else { 'FAIL' })

# 2. dry run of the seam wrapper: a path with spaces must arrive as one $args[0]
$arg = "'" + $file + "'"
$cmd = "& { 'arg0=[' + `$args[0] + ']' } " + $arg
$out = powershell.exe -NoProfile -NoLogo -Command $cmd
'argwrap(spaces): ' + $(if ($out.Trim() -eq ('arg0[' + $file + ']')) { 'PASS' } else { 'FAIL: ' + $out })

# 3. detection matrix: which source sees which candidate exe
$wellKnown = @{
  'Zed.exe'          = @("$env:LOCALAPPDATA\Programs\Zed\Zed.exe")
  'Code.exe'         = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe", "$env:ProgramFiles\Microsoft VS Code\Code.exe")
  'Cursor.exe'       = @("$env:LOCALAPPDATA\Programs\cursor\Cursor.exe")
  'Windsurf.exe'     = @("$env:LOCALAPPDATA\Programs\Windsurf\Windsurf.exe")
  'sublime_text.exe' = @("$env:ProgramFiles\Sublime Text\sublime_text.exe", "$env:ProgramFiles(x86)\Sublime Text\sublime_text.exe")
}
$rows = foreach ($exe in @('Zed.exe', 'Code.exe', 'Cursor.exe', 'Windsurf.exe', 'sublime_text.exe')) {
  $lm = Get-Item -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $exe) -ErrorAction SilentlyContinue
  $cu = Get-Item -LiteralPath ('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $exe) -ErrorAction SilentlyContinue
  $lmv = ''; if ($lm) { $lmv = [string]$lm.GetValue('') }
  $cuv = ''; if ($cu) { $cuv = [string]$cu.GetValue('') }
  $p = @($env:PATH -split ';' | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ $exe)) }) | Select-Object -First 1
  $k = @($wellKnown[$exe] | Where-Object { Test-Path -LiteralPath $_ }) | Select-Object -First 1
  [pscustomobject]@{ Exe = $exe; AppPathsHKLM = $lmv; AppPathsHKCU = $cuv; PATH = [string]$p; Known = [string]$k }
}
$rows | Format-Table -AutoSize -Wrap

# 4. cleanup
Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
'cleanup: done'
```

Optional positive path: install one of the five (e.g. `winget install -e --id Microsoft.VisualStudioCode`), re-run the matrix section, and read which column the install populates — that column's source is the authoritative one for that editor. Then two visual checks on the fixture file:

```powershell
Invoke-Item -LiteralPath '<fixture file>'                              # opens in the default app
Start-Process explorer.exe -ArgumentList @('/select,"<fixture file>"') # Explorer opens with the file selected
```

## Limits

- Executable names and the well-known directories are **guesses** for five editors; the box matrix (plus an optional real install) decides which source is authoritative per editor. The production script keeps all three sources, so a wrong table entry only loses one fallback.
- `Start-Process` is asynchronous: exit code 0 means the process was started, not that the app opened the file. Same observability class as macOS `open`; a launch failure (missing executable) is an error and goes to the `better-files.error` path.
- Store/UWP installs of an editor are not detectable (no App Paths/PATH entry) → no menu item.
- A literal `"` in a path breaks the `/select,"…"` reveal argument (rare; documented, no workaround chosen).
- A path deleted between listing and click: `explorer /select` exits 0 without a selection; `Invoke-Item` errors into the existing ERROR path. No pre-check added.
- **Verification status:** unverified. The box has no editors installed; the probe first verifies mechanics (spaces in the path, the `& { … } '<arg>'` wrapper, matrix shape), the positive detection and launch paths after the optional install.