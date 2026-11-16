# Directory listing draft

## 1. Wire contract

Current source (`better-files/mods/better-files/files/reads.js`):

```js
// shortcut: needs `sh`, so a Windows machine shows an error; add a PowerShell listing if one is used.
async function directory(path, on) {
  const script = `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=\${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt ${PER_FOLDER} ] && break; done; test -d "$1"`;
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder.");
  const fields = r.stdout.split("\0");
```

`better-files/mods/better-files/files/model.js` sets `PER_FOLDER = 500`. The parser consumes `kind\0name\0` pairs (`kind` is `d` for a directory and `f` for a file); it creates `{ name, dir: kind === "d" }`. `.git` is skipped. A nonzero process status causes the parser to throw the returned stderr, or `Cannot list this folder.` when stderr is empty.

**Source discrepancies to resolve before replacement:** the shell checks `n > 500` only *after* printing and incrementing, so it can emit 501 entries, not 500. Also, on a missing directory its final `test -d` returns nonzero but the script itself prints no stderr. The candidate below follows the requested 500-entry limit and emits a diagnostic on stderr; those differ from the literal shell behavior at the limit and for stderr, respectively. The JS fallback error remains `Cannot list this folder.`.

## 2. PowerShell candidate

PowerShell 5.1-compatible single-line `-Command` script; the path is `$args[0]`, matching the trailing `path` argument in this invocation:

```text
exec("powershell", ["-NoProfile", "-NoLogo", "-Command", `& { [Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=$args[0]; if (-not (Test-Path -LiteralPath $p -PathType Container)) { [Console]::Error.WriteLine('Cannot list this folder.'); exit 1 }; Get-ChildItem -LiteralPath $p -Force | Where-Object { $_.Name -ne '.git' } | Select-Object -First 500 | ForEach-Object { $k=if ($_.PSIsContainer) {'d'} else {'f'}; [Console]::Out.Write($k + [char]0 + $_.Name + [char]0) } } '${psQuote(path)}'`], { on })
```

`psQuote(s)` wraps a path in single quotes and doubles any embedded single quotes: `"' " + s.replace(/'/g, "''") + "' "`.

The UTF-8 output encoding leaves NUL bytes as `0x00`; `Console.Out.Write` avoids adding line breaks. `Get-ChildItem -Force` includes dotfiles, `.git` is filtered out, and `Select-Object -First 500` bounds emitted records.

**Invocation shape (box-verified 2026-11-16, PS 5.1):** PowerShell 5.1 appends trailing `-Command` arguments to the command string rather than binding them to `$args` (corrected in pwsh 7). The `& { … } '<arg>'` scriptblock wrapper routes the path through `$args` correctly on both 5.1 and 7+.

## 3. Golden output

Captured on the authoring Mac by running the exact source script with `PER_FOLDER=500` against `/tmp/wf-list-fixture`, then piping its raw stdout to `od -c`:

```text
0000000   f  \0   a   .   m   d  \0   d  \0   e   m   p   t   y   d   i
0000020   r  \0   d  \0   s   u   b  \0   f  \0   w   e   i   r   d
0000040       n   a   m   e   .   t   x   t  \0   f  \0   .   h   i   d   d
0000060   e   n  \0   f  \0   .   .   d   o   t  \0
0000073
```

Byte sequences, in order: `f\0a.md\0`; `d\0emptydir\0`; `d\0sub\0`; `f\0weird name.txt\0`; `f\0.hidden\0`; `f\0..dot\0`. The `.git` directory and its file were not listed. The fixture also had `sub/inner.txt`; listing is non-recursive.

For `/tmp/wf-list-fixture-missing`, the exact shell command returned **exit code 1**, **stderr empty**, and **stdout empty**. The JS parser therefore throws its fallback `Cannot list this folder.` message.

## 4. Box test block

Paste into Windows PowerShell 5.1 or `pwsh`; it creates a temporary fixture, writes the candidate script, captures child-process stdout/stderr to files, prints the raw bytes as a hex dump, parses the pairs for eyeballing, and prints PASS/FAIL checks. Name, dotfile, and `.git` checks run first on the small fixture; the 500-entry cap is exercised in a separate second run after 505 more files are added, so valid truncation cannot fail the name checks. The child runs under whatever PowerShell is running the block (`$PID`'s executable), so the block works in both 5.1 and 7+.

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Join-Path $env:TEMP 'wf-list-fixture'
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $root 'sub'), (Join-Path $root 'emptydir'), (Join-Path $root '.git') -Force | Out-Null
@('a.md', '.hidden', '..dot', 'weird name.txt', 'café.txt', 'sub/inner.txt', '.git/secret.txt') | ForEach-Object {
  $file = Join-Path $root $_
  New-Item -ItemType File -Path $file -Force | Out-Null
}
$candidate = @'
[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=$args[0]; if (-not (Test-Path -LiteralPath $p -PathType Container)) { [Console]::Error.WriteLine('Cannot list this folder.'); exit 1 }; Get-ChildItem -LiteralPath $p -Force | Where-Object { $_.Name -ne '.git' } | Select-Object -First 500 | ForEach-Object { $k=if ($_.PSIsContainer) {'d'} else {'f'}; [Console]::Out.Write($k + [char]0 + $_.Name + [char]0) }
'@
$scriptPath = Join-Path $env:TEMP 'wf-list-candidate.ps1'
$scriptUtf8 = New-Object System.Text.UTF8Encoding($true)
[IO.File]::WriteAllText($scriptPath, $candidate, $scriptUtf8)
$exe = (Get-Process -Id $PID).Path
$outPath = Join-Path $env:TEMP 'wf-list.stdout'
$errPath = Join-Path $env:TEMP 'wf-list.stderr'
$p = Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-NoLogo', '-Command', "& '$scriptPath' '$root'") -Wait -PassThru -NoNewWindow -RedirectStandardOutput $outPath -RedirectStandardError $errPath
$bytes = [IO.File]::ReadAllBytes($outPath)
'Hex bytes: ' + [BitConverter]::ToString($bytes)
$text = [Text.Encoding]::UTF8.GetString($bytes)
$fields = $text.Split([char]0)
$records = @()
for ($i = 0; $i + 1 -lt $fields.Length; $i += 2) { if ($fields[$i] -ne '' -or $fields[$i + 1] -ne '') { $records += [pscustomobject]@{ Kind = $fields[$i]; Name = $fields[$i + 1] } } }
'Entries: ' + (($records | ForEach-Object { $_.Kind + ':' + $_.Name }) -join ', ')
if ($p.ExitCode -eq 0) { 'PASS: existing folder exit code 0' } else { 'FAIL: existing folder exit code=' + $p.ExitCode }
if (($records.Name -contains 'a.md') -and ($records.Name -contains 'weird name.txt') -and ($records.Name -contains 'café.txt') -and ($records.Name -contains 'sub') -and ($records.Name -contains 'emptydir') -and ($records.Name -contains '.hidden') -and ($records.Name -contains '..dot')) { 'PASS: expected files and directories present' } else { 'FAIL: expected files/directories missing' }
if (($records.Name -notcontains '.git') -and ($records.Name -notcontains 'secret.txt') -and ($records.Count -eq 7)) { 'PASS: .git absent, 7 entries' } else { 'FAIL: .git leaked or count wrong (' + $records.Count + ')' }
# Second run: cap. Add 505 more files (512 total), assert exactly 500 records.
1..505 | ForEach-Object { New-Item -ItemType File -Path (Join-Path $root ('cap-{0:D3}.txt' -f $_)) -Force | Out-Null }
$capOut = Join-Path $env:TEMP 'wf-list-cap.stdout'
$p2 = Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-NoLogo', '-Command', "& '$scriptPath' '$root'") -Wait -PassThru -NoNewWindow -RedirectStandardOutput $capOut -RedirectStandardError (Join-Path $env:TEMP 'wf-list-cap.stderr')
$capFields = ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($capOut))).Split([char]0)
$capCount = 0
for ($i = 0; $i + 1 -lt $capFields.Length; $i += 2) { if ($capFields[$i] -ne '' -or $capFields[$i + 1] -ne '') { $capCount++ } }
if ($capCount -eq 500) { 'PASS: cap respected (500 of 512)' } else { 'FAIL: cap count=' + $capCount }
if ($p2.ExitCode -eq 0) { 'PASS: capped run exit code 0' } else { 'FAIL: capped run exit code=' + $p2.ExitCode }
# Third run: missing folder — non-zero exit, diagnostic on stderr.
$missing = Join-Path $env:TEMP 'wf-list-missing'
Remove-Item -LiteralPath $missing -Recurse -Force -ErrorAction SilentlyContinue
$mp = Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-NoLogo', '-Command', "& '$scriptPath' '$missing'") -Wait -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $env:TEMP 'wf-list-missing.stdout') -RedirectStandardError (Join-Path $env:TEMP 'wf-list-missing.stderr')
if ($mp.ExitCode -ne 0) { 'PASS: missing folder exit is non-zero (' + $mp.ExitCode + ')' } else { 'FAIL: missing folder exit was zero' }
'Candidate stderr on missing folder: ' + [IO.File]::ReadAllText((Join-Path $env:TEMP 'wf-list-missing.stderr'))
```

## 5. Limits

**Box-verified 2026-11-16** (UTM Win11 ARM, PS 5.1). All checks pass: NUL-delimited pairs intact, UTF-8 names round-trip (`café.txt` ✓), `-Force` includes dotfiles, `.git` excluded, exact-500 cap enforced (512 → 500), missing folder → exit 1 + stderr diagnostic, exit 0 on success. Mixed-separator paths work without normalization. The `& { … }` scriptblock invocation is **required** on PS 5.1; bare `-Command <script> <arg>` appends the arg into the command text instead of binding `$args`.
