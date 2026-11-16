# Windows 11 ARM64 install environment

## Installing Herdr on Windows 11 ARM64 (verified)

1. Install Herdr app **0.1.16** using the README manual tarball block, reproduced in [the ticket #4 working comment](https://github.com/JulioLeonPhd/herdr-mods/issues/4#issuecomment-6901181609). It selects `windows-x86_64` and installs the app under x64 emulation. The block obtains the release metadata and archive, verifies SHA-256, extracts the archive, and updates user PATH. **The one-line installer cannot be used on this box:** both `app/install.ps1` and `core/install.ps1` inspect the first non-empty of `PROCESSOR_ARCHITEW6432` and `PROCESSOR_ARCHITECTURE` and refuse anything other than AMD64. Both Windows PowerShell 5.1 and PowerShell 7.7.0 report ARM64. These environment variables reflect the OS architecture, so the check is box-level, not process-level; running either shell does not pass it.
2. Launch the app and accept its first-launch offer to install **herdr-core 0.1.21**. The app installs core natively; this path does not use the PowerShell architecture gate.
3. Install **git 2.56.0.windows.4** and **gh 2.104.0** with Winget; both are native ARM64.

Evidence: the resolution comment for issue #4 and the working comment's full recorded manual install block.

## Environment (verified)

- Box: Windows 11 ARM64 in UTM.
- Shells: Windows PowerShell 5.1 (built-in) and PowerShell 7.7.0 (Winget).
- `appHome`: `C:\Users\Julio\.config\herdr-app` (`%USERPROFILE%\.config\herdr-app`). It contains `AGENTS.md`, `herdr.d.ts`, and `mods/`. The working record notes this as the same `.config/herdr-app` convention as macOS `~/.config/herdr-app`.

## Gotchas (observed)

- The shipped layout `main.json` is read-only to the app; edits by the user migrate to `main-edited`.
- A registry PATH write does not reach already-running terminals. The installer broadcasts by setting and clearing a user variable; new tabs may inherit stale PATH until that broadcast (or a fresh window from Explorer).
- `latest.json` is served as `application/json`. `irm | ConvertFrom-Json` stringifies the parsed object and fails; the installer works around this by downloading to a file and using `Get-Content -Raw` before `ConvertFrom-Json`.
- **Missing from the ticket record:** an `exec("rm", ...)` result on Windows is not recorded. The observed program-not-found failure is `'herdr-exec': cannot run sh: program not found` (with the “This folder is empty.” fallback); the box record does not establish an `rm` result.

## Provenance

- [Ticket #4](https://github.com/JulioLeonPhd/herdr-mods/issues/4)
- [Ticket #4 working comment (issuecomment-6901181609)](https://github.com/JulioLeonPhd/herdr-mods/issues/4#issuecomment-6901181609) — full box record and verbatim baseline output.
- Ticket #4 resolution comment — [latest comment on the issue](https://github.com/JulioLeonPhd/herdr-mods/issues/4), also fetched for this record; it explicitly reports app 0.1.16 and verifies the ARM64 shell gate.
