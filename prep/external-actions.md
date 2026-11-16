# External actions: Windows draft

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
// tree.js:190,214
const failure = this.error ?? this.treeError ?? shared("better-files.error");
if (failure) root.child(Message(failure, true));
```

The editor table below matches the current built-in list exactly. The setting permits extra macOS app IDs and says they are shown only if installed:

```js
// model.js:8-15
export const EDITORS = [
  { name: "Zed", bundle: "dev.zed.Zed" },
  { name: "VS Code", bundle: "com.microsoft.VSCode" },
  { name: "Cursor", bundle: "com.todesktop.230313mzl4w4u92" },
  { name: "Windsurf", bundle: "com.exafunction.windsurf" },
  { name: "Sublime Text", bundle: "com.sublimetext.4" },
  { name: "Nova", bundle: "com.panic.Nova" },
];
// mod.schema.json:94
"description": "macOS app IDs to add to Open in, such as dev.zed.Zed. Shown only if installed."
```

Git change marks need no twin; they come from git status/diff data, not these macOS commands.


## Windows candidates

Detection candidate: for each executable below, look for `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>` and scan each PATH directory for that executable. Every executable mapping is a **guess**, not verified-known; the names are plausible Windows executable names for the exact current EDITORS entries:

| EDITORS name | macOS bundle ID (exact) | Candidate Windows executable | Status |
|---|---|---|---|
| Zed | `dev.zed.Zed` | `zed.exe` | Guessed; verify on box |
| VS Code | `com.microsoft.VSCode` | `Code.exe` | Guessed; verify on box |
| Cursor | `com.todesktop.230313mzl4w4u92` | `Cursor.exe` | Guessed; verify on box |
| Windsurf | `com.exafunction.windsurf` | `Windsurf.exe` | Guessed; verify on box |
| Sublime Text | `com.sublimetext.4` | `sublime_text.exe` | Guessed; verify on box |
| Nova | `com.panic.Nova` | `Nova.exe` | Guessed; verify on box |

Proposed calls from Herdr's `exec(program, argv, {})` (the quoted path must be escaped as a PowerShell single-quoted literal, doubling embedded single quotes):

| Action | Program + argv | One-line PowerShell 5.1 `-Command` candidate | FOUND / ERROR mapping |
|---|---|---|---|
| Detect editors | `powershell.exe`; argv: `-NoProfile`, `-Command`, `<script>` (one script checks each candidate). | `@('zed.exe','Code.exe','Cursor.exe','Windsurf.exe','sublime_text.exe','Nova.exe') | Where-Object { $exe=$_; (Test-Path -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\'+$exe)) -or (@($env:PATH -split ';' | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ $exe)) }).Count -gt 0) }` | A completed scan writes matching entries to `better-files.editors` and notifies. As today, a failed individual lookup is skipped; a miss or lookup failure does not set `better-files.error`. |
| `openInEditor` | `powershell.exe`; argv: `-NoProfile`, `-Command`, `Start-Process -FilePath '<exe>' -ArgumentList @('<path>')`. Inner launch: selected editor executable and path. | `Start-Process -FilePath 'Code.exe' -ArgumentList @('C:\path\file.txt')` | On success set `better-files.error` to null; on failure set `Could not open it in <editor name>: <stderr or it failed>`. Keep detected entries in `better-files.editors`. |
| `openWithDefault` | `powershell.exe`; argv: `-NoProfile`, `-Command`, `Invoke-Item -LiteralPath '<path>'`. | `Invoke-Item -LiteralPath 'C:\path\file.txt'` | Same shared ERROR success/failure mapping (`Could not open it: ...`). If Herdr's exec cannot drive `Invoke-Item`, use `Start-Process -FilePath '<path>'` as the fallback. |
| `revealInFinder` | `powershell.exe`; argv: `-NoProfile`, `-Command`, `Start-Process -FilePath 'explorer.exe' -ArgumentList @('/select,"<path>"')`. Inner launch: `explorer.exe`, argv `/select,"<path>"`. | `Start-Process -FilePath 'explorer.exe' -ArgumentList @('/select,"C:\path\file.txt"')` | Same shared ERROR success/failure mapping; current error text is `Could not show it in Finder: ...`, which the grill may replace with a Windows-specific label. |

These are `exec(program, argv, {})` shapes: the PowerShell script shown is the single `-Command` argv element. A path interpolated into a PowerShell single-quoted literal must double embedded single quotes. Examples use `Code.exe` for the editor call; substitute the matched candidate executable.

These command examples show the call shape, not ready-made interpolation for arbitrary paths; production must quote the actual incoming path safely. `Start-Process` is asynchronous and its own exit code does not establish that the target app opened successfully; the box run/design must decide what Herdr can observe and how to map launch failures to ERROR.

## Box probe block

Paste once into Windows PowerShell 5.1 on the UTM box. It creates and removes a small temp fixture, prints PASS/FAIL for that self-check, then prints the actual candidate registry/PATH matrix. `AppPathsKey` reports the requested HKLM key’s presence; `AppPathsValue` reports its default executable path when present.

```powershell
$ErrorActionPreference = 'Stop'
$fixture = Join-Path $env:TEMP ('better-files-probe-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $fixture | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'fixture.txt') -Value 'probe'
  if (Test-Path -LiteralPath (Join-Path $fixture 'fixture.txt')) { 'PASS temp fixture' } else { 'FAIL temp fixture' }
} catch { 'FAIL temp fixture: ' + $_.Exception.Message }
finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
$executables = @('zed.exe', 'Code.exe', 'Cursor.exe', 'Windsurf.exe', 'sublime_text.exe', 'Nova.exe')
$rows = foreach ($exe in $executables) {
  $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $exe
  $reg = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
  $regValue = if ($reg) { $reg.GetValue('') } else { '' }
  $pathHit = @($env:PATH -split ';' | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ $exe)) }) | Select-Object -First 1
  [pscustomobject]@{ Exe = $exe; AppPathsKey = [bool]$reg; AppPathsValue = $regValue; Path = if ($pathHit) { $pathHit } else { '' }; Found = [bool]($reg -or $pathHit) }
}
$rows | Format-Table -AutoSize
foreach ($row in $rows) { if ($row.Found) { 'PASS ' + $row.Exe + ' found' } else { 'FAIL ' + $row.Exe + ' missing' } }
```

## Limits

No Windows box is available from the authoring Mac. Every executable and invocation candidate is unverified, and all PowerShell syntax is unverified here. The box run must confirm PowerShell 5.1 syntax, App Paths key/value and PATH findings for each candidate, safe argument handling for paths with spaces/quotes, and what launch success/failure Herdr's `exec` can observe. The App Paths probe checks the specified HKLM location only; it does not establish whether a per-user key, alternate registry view, or another executable name is used.

The Windows menu-visibility UX is unresolved for the grill: either **hide** unsupported editor/default/reveal items, or **show** them and surface an error when invocation fails. The current guard only prevents editor detection; it does not hide default-open/reveal, and a fresh editor list is empty. Choose hide-versus-error behavior in the grill; this draft does not choose.