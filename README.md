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
switch to the highlighted session, or press `q` to return without
switching. Pi handles switching projects just as it does with `/resume`.
The picker runs in browse-only mode, so it cannot archive or delete the
session Pi has open.

By default the extension runs `pisessions` from `PATH`. Set
`PI_SESSION_PICKER_BIN` to an executable path to use another installation
(no shell arguments). For a non-default sessions directory, use the
picker's `PI_SESSIONS_ROOT` environment variable.

## Active-session registry

On Linux and macOS, Pi processes that load this extension register file-backed
sessions in `~/.cache/pi-session-picker/registry-v1/`. Records are private to
your user and contain the session ID and canonical JSONL path, the process ID
and start identity, and an `idle`, `working`, or `waiting` state. `waiting`
means Pi opened a blocking UI prompt, not that its ordinary editor is idle.
The extension updates or removes the record when Pi changes sessions or exits.

Interactive Pi instances running in a verified tmux pane also record the
socket, session, window, and pane IDs. tmux takes precedence over any outer
terminal (such as Ghostty). A crashed process can leave a record behind; reads
compare both PID and start identity, and distinguish stale records from ones
that cannot be verified. Pi instances without the extension are not tracked.

The registry does not change the behavior of `/sessions` yet. Neither tmux
switching nor Ghostty tab switching is implemented in this version.

## Development

Run `npm test` with Node.js 22.18 or later. No npm install is necessary.
