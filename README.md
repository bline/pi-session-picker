# pi-session-picker

Open the [pi-sessions](https://github.com/psychobarge/pi-sessions) terminal
browser from Pi with **`/sessions`**. Keep its filters, previews, and
cross-project browsing, then return to the same Pi process.

## Try it

Use Pi 1.6 or later and a `pisessions` executable that supports
`--select --output`. The picker mode is proposed in
[pi-sessions#8](https://github.com/psychobarge/pi-sessions/pull/8). If your
installed version doesn't have it, you can try the reviewed fork commit in
a separate Python environment:

```sh
python3 -m venv "$HOME/.local/share/pi-session-picker/venv"
"$HOME/.local/share/pi-session-picker/venv/bin/pip" install \
  "git+https://github.com/bline/pi-sessions.git@5f9c89fbaa195593e70f4a9afa3bef3d3b751cfa"
export PI_SESSION_PICKER_BIN="$HOME/.local/share/pi-session-picker/venv/bin/pisessions"
```

From this checkout, load it for one invocation:

```sh
pi -e "$PWD/extensions/session-picker.ts"
```

Or install it as a Pi package:

```sh
pi install git:github.com/bline/pi-session-picker
```

Inside Pi, enter `/sessions`. Browse or filter normally, press `r` to
select the highlighted session, or press `q` to cancel. In a verified tmux
pane or supported Ghostty tab, the picker keeps the current Pi open and
focuses or opens the selected session elsewhere. Otherwise it offers to
switch in place, with **Keep current session** selected by default.

Use **`/sessions native`** to ask for an in-place switch even in tmux or
Ghostty. The prompt warns that switching closes the current session in this
Pi instance without deleting saved history. Pi handles the replacement and
any project change just as it does with `/resume`. The picker itself cannot
archive or delete a session.

By default the extension runs `pisessions` from `PATH`. Set
`PI_SESSION_PICKER_BIN` to an executable path to use another installation
(no shell arguments). For a non-default sessions directory, use the
picker's `PI_SESSIONS_ROOT` environment variable.

## Focus across Ghostty tabs and tmux

Plain **`/sessions`** uses focus mode when it verifies a tmux pane or Ghostty
tab. Use **`/sessions focus`** to require focus mode rather than being offered
an in-place switch when no backend can be verified. Selecting the currently
open session does nothing.
On the same tmux server, it selects the exact pane on the invoking client.
For other targets, it can request focus for a verified Ghostty tab, including
a tab hosting the target's tmux client. If the target's tmux session is detached,
it can open a Ghostty tab and attach to the existing pane without starting Pi
again. It refuses ambiguous or unverifiable targets rather than opening a
second copy. The compositor decides whether a requested window is raised.

If no registered Pi is using the selected file, the picker asks where to open it:

- **Ghostty in new tmux** — new Ghostty tab with its own tmux session.
- **New tmux window** — new window in the current tmux session; only shown
  from inside tmux.
- **Ghostty without tmux** — new Ghostty tab running Pi directly.

Ghostty destinations are shown only when the invoking tab can be verified.
Ghostty support requires Linux GTK, `gdbus`, and a Ghostty build with
`GHOSTTY_SURFACE_ID` and the `present-surface` and `new-tab` D-Bus actions on the
standard single-instance service (tested with Ghostty 1.4.0). It does not
switch macOS Ghostty tabs or open a new Ghostty window.

## Keep both Pi instances with tmux

From a tmux pane, use **`/sessions tmux`** and select with `r` as usual.
Selecting the session you already have open does nothing. If another registered
Pi is using it on the same tmux server, the command brings that exact pane
forward, even in a different tmux session. It does not stop or replace either
Pi. If no registered Pi is using it, the command asks before starting
`pi --session` in a new window in the current tmux session. The `pi` executable
must be on `PATH`.

If the target is running but can't be focused, the registry can't verify it, or
multiple writable clients are viewing the source pane, the command reports the
problem instead of opening a duplicate or switching natively. Once plain
`/sessions` has chosen focus mode, a routing error does not fall back to an
in-place switch.

## Active-session registry

On Linux and macOS, Pi processes that load this extension register file-backed
sessions in `~/.cache/pi-session-picker/registry-v1/`. Records are private to
your user and contain the session ID and canonical JSONL path, the process ID
and start identity, and an `idle`, `working`, or `waiting` state. `waiting`
means Pi opened a blocking UI prompt, not that its ordinary editor is idle.
The extension updates or removes the record when Pi changes sessions or exits.

Interactive Pi instances running in a verified tmux pane also record the
socket, session, window, and pane IDs. tmux takes precedence over any outer
terminal (such as Ghostty). The outer tab, if needed, is resolved from the live
tmux client's own process, not the tmux pane's inherited environment. Pi
running directly in a verified Ghostty tab records its surface and Ghostty
process identity instead. A crashed process can leave a record behind; reads
compare both PID and start identity and distinguish stale records from ones
that cannot be verified. Pi instances without the extension are not tracked.

The registry cannot tell whether an untracked Pi already has a session open.
Install the extension in all your Pi instances for the most complete view.
Concurrent focus-mode and `/sessions tmux` launches of the same file
share a reservation until the new Pi registers or the launcher exits. If the
launcher is killed before it can clean up, the reservation can remain under
`registry-v1/launch-*`; it does not expire automatically. Only remove it after
confirming that no launch or Pi process is still using that session.

## Left Arrow shortcut

Press **Left Arrow** from Pi’s empty, focused prompt to open the same picker
as `/sessions`. It does not intercept cursor movement in a draft, active
autocomplete, or input while the agent is busy or has messages queued.

Set `PI_SESSION_PICKER_LEFT_MODE` before starting Pi to choose a behavior for
the shortcut only:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Same routing as `/sessions`. |
| `focus` | Require a verified terminal, like `/sessions focus`. |
| `tmux` | Require tmux, like `/sessions tmux`. |
| `native` | Offer a confirmed in-place switch, like `/sessions native`. |
| `off` | Disable the shortcut. |

The shortcut wraps compatible custom editors without replacing their normal
key handling. Editors that do not expose focus and autocomplete state are
left alone.

## Development

Run `npm test` with Node.js 22.18 or later. No npm install is necessary.
