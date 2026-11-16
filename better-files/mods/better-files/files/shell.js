// Platform seam for every shell-out in this mod.
// macOS paths are byte-for-byte unchanged from the original; Windows paths use
// PowerShell 5.1 with the `& { … } '<arg>'` scriptblock wrapper (required on 5.1
// because bare trailing -Command args are appended to the command text).

export const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const isWin = (platform) => platform === "windows";

// --- Directory listing ---
// Wire contract (both platforms): NUL-delimited kind/name pairs, .git skipped,
// UTF-8, capped at perFolder entries. Missing folder → non-zero exit + stderr.

function listingSh(perFolder) {
  return `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=\${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt ${perFolder} ] && break; done; test -d "$1"`;
}

function listingPs(perFolder) {
  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=$args[0]; if (-not (Test-Path -LiteralPath $p -PathType Container)) { [Console]::Error.WriteLine('Cannot list this folder.'); exit 1 }; Get-ChildItem -LiteralPath $p -Force | Where-Object { $_.Name -ne '.git' } | Select-Object -First ${perFolder} | ForEach-Object { $k=if ($_.PSIsContainer) {'d'} else {'f'}; [Console]::Out.Write($k + [char]0 + $_.Name + [char]0) }`;
}

export function pickListing(path, perFolder, platform) {
  if (isWin(platform)) {
    return {
      program: "powershell.exe",
      args: ["-NoProfile", "-NoLogo", "-Command", `& { ${listingPs(perFolder)} } ${psQuote(path)}`],
    };
  }
  return {
    program: "sh",
    args: ["-c", listingSh(perFolder), "files", path],
  };
}

// --- Image copy (viewer + markdown) ---
// Wire contract (both): exit 0 on success; source missing → non-zero, no dest created.
// macOS: cmp -s byte compare. Windows: SHA-256 hash compare (no cmp builtin in 5.1).

const COPY_IMAGE_SH = `[ -z "$3" ] || rm -f -- "$3"; mkdir -p -- "$(dirname -- "$2")" && { cmp -s -- "$1" "$2" || cp -- "$1" "$2"; }`;

const COPY_IMAGE_PS = `$src=$args[0];$dst=$args[1];$old=$args[2];try{if($old){Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue};$parent=Split-Path -Parent $dst;New-Item -ItemType Directory -Force -Path $parent -ErrorAction Stop|Out-Null;if(-not(Test-Path -LiteralPath $src -PathType Leaf)){exit 1};$copy=$true;if(Test-Path -LiteralPath $dst -PathType Leaf){$copy=(Get-FileHash -LiteralPath $src -Algorithm SHA256 -ErrorAction Stop).Hash -ne (Get-FileHash -LiteralPath $dst -Algorithm SHA256 -ErrorAction Stop).Hash};if($copy){Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop};exit 0}catch{exit 1}`;

export function pickCopyImage(src, dest, old, platform) {
  if (isWin(platform)) {
    return {
      program: "powershell.exe",
      args: ["-NoProfile", "-NoLogo", "-Command", `& { ${COPY_IMAGE_PS} } ${psQuote(src)} ${psQuote(dest)} ${psQuote(old)}`],
    };
  }
  return {
    program: "sh",
    args: ["-c", COPY_IMAGE_SH, "copy-image", src, dest, old],
  };
}

// --- Cache cleanup on tab close ---
// Wire contract (both): always exit 0; missing paths are harmless.

const RM_PS = `try{foreach($p in $args){Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue}}catch{};exit 0`;

export function pickRm(paths, platform) {
  if (isWin(platform)) {
    return {
      program: "powershell.exe",
      args: ["-NoProfile", "-NoLogo", "-Command", `& { ${RM_PS} } ${paths.map(psQuote).join(" ")}`],
    };
  }
  return { program: "rm", args: ["-f", "--", ...paths] };
}

// --- External actions: open in editor, open with default app, reveal ---

export function pickOpenInEditor(editor, path, platform) {
  if (isWin(platform)) {
    return {
      program: "powershell.exe",
      args: ["-NoProfile", "-NoLogo", "-Command", `& { Start-Process -FilePath $args[0] -ArgumentList @($args[1]) } ${psQuote(editor.exe)} ${psQuote(path)}`],
    };
  }
  return { program: "open", args: ["-b", editor.bundle, path] };
}

export function pickOpenWithDefault(path, platform) {
  if (isWin(platform)) {
    return {
      program: "powershell.exe",
      args: ["-NoProfile", "-NoLogo", "-Command", `& { Invoke-Item -LiteralPath $args[0] } ${psQuote(path)}`],
    };
  }
  return { program: "open", args: [path] };
}

export function pickReveal(path, platform) {
  if (isWin(platform)) {
    return {
      program: "powershell.exe",
      args: ["-NoProfile", "-NoLogo", "-Command", `& { Start-Process -FilePath 'explorer.exe' -ArgumentList @('/select,"' + $args[0] + '"') } ${psQuote(path)}`],
    };
  }
  return { program: "open", args: ["-R", path] };
}

export const revealLabel = (platform) => (isWin(platform) ? "Show in Explorer" : "Show in Finder");
export const revealError = (platform) => (isWin(platform) ? "show it in Explorer" : "show it in Finder");

// --- Editor detection ---
// macOS: one mdfind per bundle ID (unchanged).
// Windows: one PowerShell process probes App Paths (HKLM→HKCU), PATH, and
// well-known dirs for every candidate; first hit wins. Emits name\0exePath\0
// pairs (UTF-8, NUL convention). Always exits 0.

const KNOWN_WINDOWS_DIRS = {
  "Zed.exe": [`Join-Path $env:LOCALAPPDATA 'Programs\\Zed\\Zed.exe'`],
  "Code.exe": [
    `Join-Path $env:LOCALAPPDATA 'Programs\\Microsoft VS Code\\Code.exe'`,
    `Join-Path $env:ProgramFiles 'Microsoft VS Code\\Code.exe'`,
  ],
  "Cursor.exe": [`Join-Path $env:LOCALAPPDATA 'Programs\\cursor\\Cursor.exe'`],
  "Windsurf.exe": [`Join-Path $env:LOCALAPPDATA 'Programs\\Windsurf\\Windsurf.exe'`],
  "sublime_text.exe": [
    `Join-Path $env:ProgramFiles 'Sublime Text\\sublime_text.exe'`,
    `Join-Path $env:ProgramFiles(x86) 'Sublime Text\\sublime_text.exe'`,
  ],
};

function detectEditorsPs(allEditors) {
  const candidates = allEditors
    .filter((e) => e.exe && e.name)
    .map((e) => `@(${psQuote(e.name)},${psQuote(e.exe)},@(${(KNOWN_WINDOWS_DIRS[e.exe] ?? []).join(",")}))`)
    .join(",");
  const script =
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ` +
    `$cands=@(${candidates}); ` +
    `foreach($c in $cands){ ` +
    `$exe=$c[1]; $found=$null; ` +
    `$lm=Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe" -ErrorAction SilentlyContinue; ` +
    `if($lm -and $lm.'(default)'){$found=[string]$lm.'(default)'}; ` +
    `if(-not $found){ $cu=Get-ItemProperty -Path "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe" -ErrorAction SilentlyContinue; if($cu -and $cu.'(default)'){$found=[string]$cu.'(default)'} }; ` +
    `if(-not $found){ $pd=@($env:PATH -split ';' | ForEach-Object { if($_ -and (Test-Path -LiteralPath (Join-Path $_ $exe))){ Join-Path $_ $exe } } | Select-Object -First 1); if($pd){ $found=$pd } }; ` +
    `if(-not $found){ foreach($d in $c[2]){ if(Test-Path -LiteralPath $d){ $found=$d; break } } }; ` +
    `if($found){ [Console]::Out.Write($c[0] + [char]0 + $found + [char]0) } ` +
    `}; exit 0`;
  return { program: "powershell.exe", args: ["-NoProfile", "-NoLogo", "-Command", script] };
}

export function pickDetectEditors(baseEditors, extra, platform) {
  if (isWin(platform)) {
    return { kind: "single", ...detectEditorsPs([...baseEditors, ...extra]) };
  }
  return {
    kind: "perEditor",
    probes: [...baseEditors, ...extra].map((e) => ({
      editor: e,
      program: "mdfind",
      args: [`kMDItemCFBundleIdentifier == '${String(e.bundle).replace(/'/g, "")}'`],
    })),
  };
}
