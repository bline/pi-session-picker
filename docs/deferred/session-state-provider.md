# Deferred: external session-state provider for pisessions

Revisit after the upstream [picker modes PR (pi-sessions#8)](https://github.com/psychobarge/pi-sessions/pull/8) lands. This is a separate, optional upstream change, not part of the picker modes PR. No provider API is committed here.

## Why

`pisessions` currently infers whether a session is live from its transcript's modification time. A Pi that has been idle for hours can still have that file open. The picker extension's [active-session registry](../../README.md#active-session-registry) can identify such a process when it has registered, but the standalone browser should not need to know the registry format or depend on the extension.

## Proposed boundary

- **`pisessions`** owns the status display and Archive/Delete policy. Consider an optional `--state-provider EXECUTABLE`, usable in the standalone browser as well as in `--advanced-select`. Without a provider, nothing changes.
- **`pi-session-picker`** owns the registry and would supply a separate adapter once the upstream interface is agreed. The adapter would translate verified registry data into a small, versioned JSON response keyed by canonical local transcript paths. It would not expose tmux or Ghostty routing details.

## Status and protection

| Provider result | Proposed behavior |
| --- | --- |
| Known open | Show `idle`, `working`, or `waiting` as appropriate; protect the transcript in all three states. |
| Not reported | Preserve the existing recent-activity heuristic. No record is not proof that the session is closed. |
| Unverified or unavailable | Keep browsing usable and explain why Archive/Delete is blocked for the affected session or project. If the provider cannot identify what is affected, block those actions until a check succeeds. |

The registry can cover every open file-backed session in one Pi configuration if every process loads the extension and registers successfully. The adapter must not infer that setup, or coverage of other Pi configurations, from a missing record.

Use a snapshot for display. Before Archive/Delete, make a fresh check after any confirmation and immediately before changing files. For a project-wide operation, check the whole project, not just the rows shown by the last scan. Run the configured provider without a shell and with a timeout so a stalled provider cannot hang browsing. The upstream PR can test the interface with a fake provider; it need not include the registry adapter.

A fresh check reduces the chance of changing a transcript in use. It does not eliminate a concurrent launch between checking and acting; a shared reservation protocol is out of scope for this follow-up.
