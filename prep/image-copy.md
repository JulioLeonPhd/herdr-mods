# Image-copy / cache-cleanup draft

## 1. Semantics spec

Current source (`better-files/mods/better-files/views/viewer.js:31–33`):

> // $1 the file, $2 its copy, $3 the copy of what this tab showed before. No file name reaches
> // the script itself, and only the cache's own copies are ever removed.
> const COPY_IMAGE = `[ -z "$3" ] || rm -f -- "$3"; mkdir -p -- "$(dirname -- "$2")" && { cmp -s -- "$1" "$2" || cp -- "$1" "$2"; }`;

Call sites (`viewer.js:385–388`, `:450`):

> const result = await exec(
>   "sh",
>   ["-c", COPY_IMAGE, "copy-image", file.path, `${appHome()}/${copy}`, old],
>   {},
> );

> const result = await exec("sh", ["-c", COPY_IMAGE, "copy-image", path, `${appHome()}/${copy}`, ""], {});

| Item | Current behavior | JS interpretation |
|---|---|---|
| `$1` | Source image file. | `readImage` uses `file.path`; markdown preview uses `path`. |
| `$2` | Destination copy under `${appHome()}/${copy}` (the app cache). | This is the path displayed/used on success. |
| `$3` | Optional previous cache copy. If non-empty, `rm -f -- "$3"` runs first; missing path is harmless. Empty string skips deletion. | `readImage` may pass an old copy; markdown always passes `""`. |
| Effect order | Delete non-empty old copy → `mkdir -p` the destination parent → compare source/dest with `cmp -s`; copy only when different. | Old copy can already be removed if a later step fails. |
| Exit status | `0` when command list succeeds. Missing/unreadable source causes compare/copy failure and non-zero status; destination is not created for a missing source. | `result?.code === 0` means success. Any other code or rejected `exec` means `This file is no longer available.` in `readImage`; markdown marks the preview unavailable. |

Current close cleanup (`better-files/mods/better-files/main.js:106–110`):

> // A closing tab takes its copies of images with it.
> async close() {
>   const copies = [this.imageCopy, ...(this.markdownCopies?.values() ?? [])].filter(Boolean);
>   if (copies.length) await exec("rm", ["-f", "--", ...copies.map((c) => `${appHome()}/${c}`)], {}).catch(() => {});
> }

This invokes `rm` as a program, not through `sh`. On Windows that program may not exist; the JS contract ignores rejection. Missing paths are also harmless.

## 2. PowerShell candidate (COPY_IMAGE twin)

One-line `-Command` candidate for PowerShell 5.1; receives source, destination, and optional old path as `$args[0]`, `$args[1]`, `$args[2]`:

```powershell
$src=$args[0];$dst=$args[1];$old=$args[2];try{if($old){Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue};$parent=Split-Path -Parent $dst;New-Item -ItemType Directory -Force -Path $parent -ErrorAction Stop|Out-Null;if(-not(Test-Path -LiteralPath $src -PathType Leaf)){exit 1};$copy=$true;if(Test-Path -LiteralPath $dst -PathType Leaf){$copy=(Get-FileHash -LiteralPath $src -Algorithm SHA256 -ErrorAction Stop).Hash -ne (Get-FileHash -LiteralPath $dst -Algorithm SHA256 -ErrorAction Stop).Hash};if($copy){Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop};exit 0}catch{exit 1}
```

Intended invocation: `exec("powershell", ["-NoProfile", "-NoLogo", "-Command", `& { <script> } '${psQuote(src)}' '${psQuote(dest)}' '${psQuote(old)}'`])`; pass `old` as an empty string when absent (renders as `''` in the command). The `& { … }` scriptblock wrapper is **required** on PS 5.1, which appends bare `-Command` arguments to the command text instead of binding them to `$args` (fixed in pwsh 7). Old-copy deletion precedes parent creation and source check, matching the current order. Exit 0 only on success; exit 1 for absent/unreadable source or other copy failure.

## 3. PowerShell candidate (cache cleanup twin)

One-line `-Command` candidate for the current `rm -f -- ...paths` call:

```powershell
try{foreach($p in $args){Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue}}catch{};exit 0
```

Invoke: `exec("powershell", ["-NoProfile", "-NoLogo", "-Command", `& { <script> } '${paths.map(psQuote).join("' '")}'`])`. The `& { … }` wrapper ensures paths arrive as `$args` on PS 5.1. The script suppresses missing-path and removal errors and always returns 0, mirroring the awaited JS call's `.catch(() => {})` behavior. `main.js:109` currently asks `exec` to launch `rm` directly; a missing Windows program is the same ignored-rejection class as the `sh` blocker.

## 4. Box test block

Paste into Windows PowerShell 5.1. It creates its own fixture under `$env:TEMP`, launches each candidate as a child PowerShell process, and prints PASS/FAIL. This deliberately exercises the command-line argument and exit-code path as well as file behavior.

```powershell
$ErrorActionPreference='Stop'
$CopyScript='$src=$args[0];$dst=$args[1];$old=$args[2];try{if($old){Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue};$parent=Split-Path -Parent $dst;New-Item -ItemType Directory -Force -Path $parent -ErrorAction Stop|Out-Null;if(-not(Test-Path -LiteralPath $src -PathType Leaf)){exit 1};$copy=$true;if(Test-Path -LiteralPath $dst -PathType Leaf){$copy=(Get-FileHash -LiteralPath $src -Algorithm SHA256 -ErrorAction Stop).Hash -ne (Get-FileHash -LiteralPath $dst -Algorithm SHA256 -ErrorAction Stop).Hash};if($copy){Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop};exit 0}catch{exit 1}'
$CleanupScript='try{foreach($p in $args){Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue}}catch{};exit 0'
$root=Join-Path $env:TEMP 'wf-copy-fixture';Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
$srcDir=Join-Path $root 'src';$cache=Join-Path $root 'cache';New-Item -ItemType Directory -Force -Path $srcDir,$cache|Out-Null
$src=Join-Path $srcDir 'input';$dest=Join-Path $cache 'fresh'
function Check($name,$ok){if($ok){"PASS $name"}else{"FAIL $name"}}
function Q($s){ "'" + ([string]$s -replace "'","''") + "'" }
function Run-Copy($s,$d,$o){& powershell.exe -NoProfile -NoLogo -Command ("& { " + $CopyScript + " } " + (Q $s) + " " + (Q $d) + " " + (Q $o));return $LASTEXITCODE}
[IO.File]::WriteAllText($src,'fresh');$code=Run-Copy $src $dest '';Check 'fresh copy' ($code -eq 0 -and [IO.File]::ReadAllText($dest) -eq 'fresh')
$dest=Join-Path $cache 'changed';[IO.File]::WriteAllText($dest,'old');[IO.File]::WriteAllText($src,'changed');$code=Run-Copy $src $dest '';Check 'changed source replaces destination' ($code -eq 0 -and [IO.File]::ReadAllText($dest) -eq 'changed')
$dest=Join-Path $cache 'identical';[IO.File]::WriteAllText($src,'identical');Copy-Item -LiteralPath $src -Destination $dest;$fixed=[DateTime]::UtcNow.AddDays(-5);[IO.File]::SetLastWriteTimeUtc($dest,$fixed);$before=[IO.File]::GetLastWriteTimeUtc($dest).Ticks;$code=Run-Copy $src $dest '';$after=[IO.File]::GetLastWriteTimeUtc($dest).Ticks;Check 'identical source leaves mtime unchanged' ($code -eq 0 -and $before -eq $after)
$old=Join-Path $cache 'old';$dest=Join-Path $cache 'with-old';[IO.File]::WriteAllText($old,'old-cache');[IO.File]::WriteAllText($src,'replacement');$code=Run-Copy $src $dest $old;Check 'existing old copy deleted' ($code -eq 0 -and -not(Test-Path -LiteralPath $old) -and [IO.File]::ReadAllText($dest) -eq 'replacement')
$keep=Join-Path $cache 'keep';$dest=Join-Path $cache 'empty-old';[IO.File]::WriteAllText($keep,'keep');$code=Run-Copy $src $dest '';Check 'empty old argument deletes nothing' ($code -eq 0 -and (Test-Path -LiteralPath $keep) -and [IO.File]::ReadAllText($keep) -eq 'keep')
$missing=Join-Path $srcDir 'missing';$dest=Join-Path $cache 'missing';$code=Run-Copy $missing $dest '';Check 'missing source fails without destination' ($code -ne 0 -and -not(Test-Path -LiteralPath $dest))
$cleanupPath=Join-Path $cache 'cleanup';[IO.File]::WriteAllText($cleanupPath,'remove');& powershell.exe -NoProfile -NoLogo -Command ("& { " + $CleanupScript + " } " + (Q $cleanupPath) + " " + (Q (Join-Path $cache 'absent')));$cleanupCode=$LASTEXITCODE;Check 'cache cleanup removes existing and ignores missing paths' ($cleanupCode -eq 0 -and -not(Test-Path -LiteralPath $cleanupPath))
```

## 5. Limits

**Box-verified 2026-11-16** (UTM Win11 ARM, PS 5.1). All seven checks pass: fresh copy, changed-source replace, identical-source skip (mtime preserved), old-copy deletion, empty-old no-op, missing-source failure (exit 1, no dest), cleanup (removes existing, ignores absent, exit 0). Mixed-separator paths (`C:\…/cache/…`) work without normalization. The `& { … }` scriptblock wrapper is **required** on PS 5.1 (bare `-Command <script> <arg1> <arg2>` appends args into the command text instead of binding `$args`). The candidate uses `Get-FileHash` rather than `cmp -s`; this is a hash-based simplification of byte comparison (SHA-256 collision risk negligible, not literal byte equality).

Real Mac `sh` observations: exact script used was `[ -z "$3" ] || rm -f -- "$3"; mkdir -p -- "$(dirname -- "$2")" && { cmp -s -- "$1" "$2" || cp -- "$1" "$2"; }`, run with `sh -c "$COPY_IMAGE" copy-image src dest old` against `/tmp/wf-copy-fixture`.

| Scenario | Exit | Resulting state observed |
|---|---:|---|
| Fresh copy, no destination | 0 | Destination contains `fresh-content`; old absent. |
| Changed source, existing destination | 0 | Destination replaced with `new-content`; old absent. |
| Identical source/destination | 0 | Destination contains `same-content`; mtime stayed `1577930640` (`before=1577930640`, `after=1577930640`). |
| `$3` points at existing old copy | 0 | Destination contains `replacement`; old path absent. |
| `$3` empty | 0 | Destination contains `replacement`; independent `keep` file still contains `keep-me`. |
| Missing source | 1 | Destination absent; `cp` reported source not found. |
