# Smoke protocol and verification checklists (grill #8)

## 1. Smoke-run protocol (design phase — UTM box)

### Who does what

| Role | Action |
|---|---|
| **Agent** (Mac) | Writes a single pasteable PowerShell block per smoke area; posts it as a comment on the relevant ticket (or in chat); interprets the pasted output. |
| **User** (box operator) | Pastes the block into **Windows PowerShell 5.1** on the UTM box (not `pwsh`, unless the test explicitly says so); waits for completion; copies the full stdout back. |
| **Agent** (Mac) | Reads the pasted output; marks PASS/FAIL; if any FAIL, diagnoses, adjusts the candidate, and re-issues a corrected block. |

### How results land

- **Primary:** user pastes the raw stdout into the chat conversation or as a ticket comment.
- **Secondary (for large outputs):** the block writes a scratch file (`$env:TEMP\wf-smoke-results.txt`) and the user pastes only the final summary lines; the agent can request the full file if needed.
- **No CI / no GitHub Actions for this phase.** The UTM box is the single source of truth for Windows behavior.

### Execution order

The smoke blocks are **sequential** (each may depend on the prior one's fixture state) but are **idempotent** (each creates its own fixture under `$env:TEMP`, cleans up in a `finally` block, and can be re-run). The operator runs them in ticket order:

1. `prep/listing.md` §4 — listing wire contract (ticket #5, already box-verified).
2. `prep/image-copy.md` §4 — copy + cleanup (ticket #5, already box-verified).
3. `prep/external-actions.md` §4 — detection matrix + launch-shape probes (ticket #7).
4. `prep/verification.md` §3 — end-to-end smoke (this doc; runs after the mod is built or as a dry-run of the expected behavior).

### Pass criterion for the map

The map (#1) is **done** when every item in the **Smoke List** (§2) passes on the box. "Done" means the handoff spec is build-ready; no implementation is required in the map phase.

---

## 2. Smoke List (defines "done" for the map)

Seven end-to-end behaviors that must be demonstrably working on the UTM box. Each is a single observable outcome:

| # | Check | What to observe | Pass criterion |
|---|---|---|---|
| S1 | **Tree loads** | Open better-files on a local folder in the box | Sidebar shows a folder tree with correct names, types (dir/file icons), no error banner |
| S2 | **Text file opens** | Click a `.md` or `.txt` file in the tree | Viewer pane shows the file content, syntax-highlighted |
| S3 | **Markdown file opens** | Click a `.md` file containing headings, code fences, and an image reference | Viewer renders rendered Markdown (not raw source); image reference resolved |
| S4 | **Image file opens** | Click a `.png` or `.jpg` file in the tree | Viewer shows the image; a cache copy exists under `appHome()` |
| S5 | **Change marks show** | In a git repo folder, modify a file (touch/add) | Tree shows the change mark (colored dot / letter) on the modified file |
| S6 | **Send-to-agent** | Right-click a file → "Send to agent" (or equivalent context-menu action) | The file path/content appears in the agent's context (observable in the agent panel or log) |
| S7 | **Open in editor** | Right-click a file → "Open in VS Code" (or whichever editor is installed) | The editor launches with the file open (visual confirmation) |

**Notes:**
- S5 requires git to be installed on the box (confirmed: git 2.56.0 is present).
- S6 requires at least one agent to be configured in the Herdr app on the box.
- S7 requires at least one editor to be installed on the box. If no editor is installed, S7 is marked **SKIPPED (no editor)** and does not block the map from closing, but the detection mechanism (ticket #7 probe) must still pass.
- S1–S4 exercise the file-I/O mechanism (ticket #5). S5 exercises git. S6–S7 exercise external actions (ticket #7).

---

## 3. Smoke-run script (end-to-end, post-build)

This block is run **after the mod is built** (i.e., in the build session, not the design phase). It exercises the actual mod code paths through the Herdr app's `exec` API. It assumes the mod is loaded in the Herdr app on the box.

Because the mod runs inside the Herdr app, this block is a **manual UI walkthrough**, not a PowerShell script. The operator:

1. Opens the Herdr app on the box.
2. Navigates to a test folder (e.g., `C:\wf-test` with known fixture files).
3. Performs each S1–S7 check above and records PASS/FAIL/SKIPPED.
4. Reports the results as a comment on ticket #8 (or in chat).

A PowerShell pre-flight block can verify the **prerequisites** (correct files exist, git repo is initialized, an editor is installed) before the UI walkthrough:

```powershell
# Pre-flight: verify fixture + prerequisites
$root = 'C:\wf-test'
$checks = @(
  @{ Name='fixture dir';        Test=(Test-Path -LiteralPath $root) },
  @{ Name='text file';          Test=(Test-Path -LiteralPath (Join-Path $root 'readme.md')) },
  @{ Name='image file';         Test=(Test-Path -LiteralPath (Join-Path $root 'test.png')) },
  @{ Name='git repo';           Test=(Test-Path -LiteralPath (Join-Path $root '.git')) },
  @{ Name='git available';      Test=(Get-Command git -ErrorAction SilentlyContinue) -ne $null }
)
foreach ($c in $checks) {
  if ($c.Test) { "PASS  $($c.Name)" } else { "FAIL  $($c.Name)" }
}
# Editor check (any of the five; PATH only — the #7 matrix probe covers registry + known dirs)
$editorExes = @('Code.exe','Cursor.exe','Zed.exe','Windsurf.exe','sublime_text.exe')
$found = foreach ($exe in $editorExes) {
  $p = [Environment]::GetEnvironmentVariable('PATH','Machine').Split(';') +
       [Environment]::GetEnvironmentVariable('PATH','User').Split(';')
  $hit = @($p | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ $exe)) }) | Select-Object -First 1
  if ($hit) { $exe }
}
if ($found) { "INFO  Editor on PATH: $found" } else { "SKIP  No editor on PATH (S7 may still pass via App Paths / known dirs — see #7 matrix)" }
```

---

## 4. Full behavior checklist (build session)

This is the comprehensive list the handoff spec carries into the build session. It covers every behavior that must be verified after the mod code is written. Organized by subsystem.

### 4.1 Platform branching

| ID | Check | Method |
|---|---|---|
| B1.1 | `window().platform` returns `"windows"` on the box, `"darwin"` on the Mac | Log the value at mod init |
| B1.2 | macOS code path is byte-for-byte unchanged (no behavioral drift) | Diff the macOS code path before/after; run existing Mac tests |
| B1.3 | Platform branch is in one place per call site (no scattered `if (windows)`) | Code review |

### 4.2 File listing

| ID | Check | Method |
|---|---|---|
| B2.1 | NUL-delimited `kind\0name\0` pairs parsed correctly | Box: S1; unit: feed known stdout to parser |
| B2.2 | UTF-8 names round-trip (e.g., `café.txt`, `日誌.md`) | Box: fixture with non-ASCII names |
| B2.3 | Dotfiles included (`.hidden`, `..dot`) | Box: fixture; visual check in tree |
| B2.4 | `.git` directory excluded | Box: fixture with `.git/`; verify absent in tree |
| B2.5 | 500-entry cap: folder with 512 entries shows exactly 500 | Box: generate 512 files; count tree entries |
| B2.6 | Missing folder → `treeError` shown in sidebar, no crash | Box: navigate to a deleted path |
| B2.7 | Empty folder → empty tree, no error | Box: navigate to empty folder |
| B2.8 | Long path (>260 chars, no `\\?\` prefix) | Box: create a deep nested fixture; observe behavior (error vs. truncation vs. works) |
| B2.9 | UNC path (`\\server\share\folder`) | Box: if a UNC share is available; otherwise document as untested limitation |

### 4.3 File viewing

| ID | Check | Method |
|---|---|---|
| B3.1 | Plain text file renders with syntax highlighting | Box: S2 |
| B3.2 | Markdown renders (headings, code fences, lists, links) | Box: S3 |
| B3.3 | 400k-char cap: file > 400 000 chars shows truncation indicator, no crash | Box: generate a 500k-char file; open it |
| B3.4 | Binary file (e.g., `.png` opened as text): graceful handling, no crash | Box: click a binary file in text view mode |
| B3.5 | File deleted while open: viewer shows error, no crash | Box: open a file, delete it externally, refresh |
| B3.6 | Non-ASCII filename in viewer title/label | Box: open `café.txt`; verify title renders |

### 4.4 Image display + cache

| ID | Check | Method |
|---|---|---|
| B4.1 | Image opens in viewer; cache copy created under `appHome()` | Box: S4; verify file exists in cache dir |
| B4.2 | Reopen same image: cache hit, no re-copy (mtime unchanged) | Box: open, note mtime, close, reopen, compare mtime |
| B4.3 | Source image modified: next open copies new version (hash differs) | Box: modify source, reopen |
| B4.4 | Tab close: all cache copies for that tab are deleted | Box: open 2 images, close tab, verify cache dir is empty |
| B4.5 | Markdown with embedded images: images render through cache | Box: S3 (markdown with `![](local.png)`) |
| B4.6 | Image in a subfolder (relative path resolution) | Box: markdown referencing `./sub/img.png` |
| B4.7 | Cache dir creation: `mkdir -p` equivalent creates nested dirs | Box: verify cache dir structure |

### 4.5 Git integration

| ID | Check | Method |
|---|---|---|
| B5.1 | `git status --porcelain` marks appear in tree (M, A, D, U, etc.) | Box: S5; modify/add/delete files in a git repo |
| B5.2 | `git diff -U0` hunk view opens on click | Box: click a modified file's change mark |
| B5.3 | Git absent: no marks, no error, no crash | Box: navigate to a non-git folder; verify no marks, no error |
| B5.4 | Git repo with no changes: tree loads, no marks | Box: clean repo |
| B5.5 | Git repo with many changes (>100 files): performance acceptable (<2s to render) | Box: large repo with many modified files |

### 4.6 External actions

| ID | Check | Method |
|---|---|---|
| B6.1 | Editor detection: only installed editors appear in context menu | Box: S7 prerequisite; verify menu shows only installed editors |
| B6.2 | "Open in \<Editor\>" launches the editor with the file | Box: S7; visual confirmation |
| B6.3 | "Open in default app" launches the OS default app | Box: right-click a `.txt` → default app opens |
| B6.4 | "Show in Explorer" selects the file in Explorer | Box: right-click → "Show in Explorer"; verify Explorer opens with file selected |
| B6.5 | Editor not installed: no menu item (not a broken item) | Box: verify absent editor is not in menu |
| B6.6 | Launch failure (e.g., editor crashes on launch): error message in sidebar | Box: hard to reproduce; verify code path by review |
| B6.7 | Path with spaces in editor/reveal actions | Box: fixture file in a spaced directory; use each action |
| B6.8 | Path with special characters (`&`, `(`, `)`, `'`, `"`) | Box: fixture with such names; verify no command injection / parse error |

### 4.7 Refresh and file watching

| ID | Check | Method |
|---|---|---|
| B7.1 | File added to watched folder: tree refreshes, new file appears | Box: create a file externally; verify it appears in tree |
| B7.2 | File deleted from watched folder: tree refreshes, file disappears | Box: delete a file externally; verify it disappears |
| B7.3 | File renamed: tree refreshes | Box: rename a file externally |
| B7.4 | Folder added/removed: tree refreshes | Box: create/delete a subfolder externally |
| B7.5 | Refresh is not excessive: no CPU spike from polling (if polling is used) | Box: open Performance Monitor; observe CPU over 60s with no changes |

### 4.8 Tab and space semantics

| ID | Check | Method |
|---|---|---|
| B8.1 | Shared tab: better-files and better-changes show consistent state | Box: open same folder in both; verify marks match |
| B8.2 | Keep tab: state persists across space switches | Box: open a file, switch space, switch back; file still open |
| B8.3 | Tab close: image cache cleaned up, no orphan files | Box: open images, close tab, check cache dir |
| B8.4 | Multiple tabs: independent state (different folders) | Box: open two tabs with different folders; verify independence |

### 4.9 Error handling and robustness

| ID | Check | Method |
|---|---|---|
| B9.1 | `exec` rejection (program not found): graceful error, no crash | Box: temporarily rename `powershell.exe` (or simulate); verify error message |
| B9.2 | `better-files.error` shared state: displayed in sidebar, cleared on next success | Box: trigger an error; verify it appears; trigger success; verify it clears |
| B9.3 | `treeError` for listing failure: shown in tree area, not in viewer | Box: navigate to a permission-denied folder |
| B9.4 | Concurrent operations (open 5 files rapidly): no race conditions, no corruption | Box: rapid-click 5 files; verify all open correctly |
| B9.5 | App restart: mod reloads, state is consistent (no stale cache) | Box: restart Herdr app; verify tree and cache state |

### 4.10 Windows-specific edge cases

| ID | Check | Method |
|---|---|---|
| B10.1 | Drive letters: `C:\`, `D:\`, etc. all work | Box: fixture on C: and D: (if D: exists) |
| B10.2 | Path with spaces: `C:\Program Files\...` | Box: fixture in `C:\Program Files\wf-test\` |
| B10.3 | Path with single quote: `C:\test\it's a file.txt` | Box: fixture; verify PS quoting handles it |
| B10.4 | Path with double quote: `C:\test\it"s a file.txt` | Box: fixture; verify behavior (may be a documented limitation) |
| B10.5 | Very long path (>260 chars): documented behavior | Box: create deep path; record what happens |
| B10.6 | `appHome()` resolves correctly: `C:\Users\<user>\.config\herdr-app` | Box: log the value; verify writable |
| B10.7 | Mixed-separator path (`C:\Users\…/cache/…`): works without normalization | Box: verified in #5 (3R probe); re-confirm in build |

---

## 5. Reporting format

Each check reports one of:
- **PASS** — behavior confirmed correct.
- **FAIL** — behavior incorrect; include expected vs. actual, error message, and relevant log output.
- **SKIPPED** — prerequisite not met (e.g., no editor installed, no UNC share); include reason.

For box runs, the report is a flat list:
```
PASS  S1 tree loads
PASS  S2 text file opens
PASS  S3 markdown file opens
PASS  S4 image file opens
PASS  S5 change marks show
SKIPPED S6 send-to-agent (no agent configured on box)
PASS  S7 open in editor (VS Code)
```

For the full build-session checklist, the same format extended with the B-prefixed IDs:
```
PASS  B2.1 NUL-delimited pairs parsed
PASS  B2.2 UTF-8 names round-trip
FAIL  B2.8 Long path >260: "The filename or extension is too long" at depth 271
...
```

## 6. Limits

- The smoke list (S1–S7) is the **minimum** for map completion. The full checklist (B*) is the **build-session** verification target; not all items need to pass for the map to close, but all must be addressed (pass, fail-with-workaround, or documented limitation) before the mod is considered production-ready.
- UNC path testing (B2.9) may not be feasible on an isolated UTM box; mark SKIPPED with reason if no share is available.
- The 400k-char cap (B3.3) tests the existing `MAX_CHARS` constant; the Windows-specific concern is whether the PS listing or the Node `readTextFile` handles large files without OOM on the ARM64 box.
- Concurrent operation testing (B9.4) is qualitative; there is no automated race detector in the mod runtime.
- This checklist is a **design artifact**: it defines what to check, not how to fix failures. Fix strategies are the build session's responsibility.