# Re-record the release demo

This records the real Pi and `pisessions` interfaces in Ghostty on a **private,
headless Wayland compositor**. It never points the recorder at the current
login session. Three Ghostty tabs—API Reliability, Design System, and Release
Ops—each contain a named tmux workspace with three live Pi sessions.

The intro shows the three windows in Design System, then returns to API
Reliability. The first picker jump stays in the API Reliability tab and selects
another tmux window. The second jump brings the Release Ops tab forward and
selects CI Cache, a window that wasn't showing in that tab. Each workspace has a
separate private tmux socket; with a shared server the picker would use the
current tmux client rather than switch Ghostty tabs. The capture validates
Ghostty's configuration, checks native terminal focus and window selection, and
verifies that all nine original panes and Pi processes survive.

## Run on Linux

Use Python 3.10+, Pi 1.6+, a picker-enabled `pisessions` (see the [install
guide](../../README.md#install)), Ghostty's Linux GTK build with the D-Bus tab
actions, labwc with GLES/headless support, `wf-recorder` with FFV1, tmux,
`dbus-run-session`, `gdbus`, FFmpeg with `drawtext` and `libx264`, `rg`, `fd`, and
DejaVu Sans Mono and Lato fonts. Tested with Ghostty 1.4.0, labwc 0.9.3,
wf-recorder 0.6.0, and tmux 3.6. The output and optional review
directory must be new paths under existing directories.

```sh
python3 docs/demo/record.py \
  --review-dir /tmp/pi-picker-demo-review \
  /tmp/pi-picker-demo.mp4
```

If the `pi` launcher requires a desktop sandbox or inherits the real user home,
point `--pi-command` at the underlying CLI (e.g. `'node /path/to/pi/dist/cli.js'`).
Use `--ghostty /path/to/ghostty` (or the extracted `AppRun`),
`--pisessions /path/to/pisessions`, `--fd fdfind`, and
`--render-device /dev/dri/renderD128` if needed. A
machine where labwc cannot create its private headless output should fail, not
fall back to recording the current desktop.

## Review before sharing

`record.py` generates all nine transcripts from constants. The capture process
starts with an allowlisted environment, fresh HOME, XDG directories, Pi settings,
transcript root, Wayland/D-Bus session, and tmux sockets. Pi runs offline with a
display-only model and a dummy loopback URL. The walkthrough sends no prompts;
`pisessions` update checks are disabled.

`--review-dir` saves the lossless capture, caption timings, and terminal snapshots.
Check the final streams and metadata and extract review sheets with:

```sh
python3 docs/demo/review.py /tmp/pi-picker-demo.mp4 /tmp/pi-picker-demo-review
```

Inspect the snapshots and all distinct screen states in `raw-sheet-*.png`,
including transitions. Check the captions and both jumps in the final video at
full size. The only projects should be `api-reliability`, `design-system`, and
`release-ops`. The paths and session IDs should come from the generated fixtures.
Expect one H.264 video stream, no audio, and only standard encoder/container
metadata. Share the reviewed MP4, not the intermediate capture.

## Refresh the README demo

Generate the 1152×720, 10 fps GIF from the reviewed MP4. It plays once rather
than looping indefinitely.

```sh
mp4=/tmp/pi-picker-demo.mp4
palette=/tmp/pi-picker-demo-review/gif-palette.png
filters='fps=10,scale=1152:-2:flags=lanczos'
ffmpeg -v error -nostdin -n -i "$mp4" \
  -vf "$filters,palettegen=stats_mode=diff" -frames:v 1 -update 1 "$palette" &&
ffmpeg -v error -nostdin -n -i "$mp4" -i "$palette" \
  -filter_complex "[0:v]$filters[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop -1 /tmp/pi-picker-demo.gif
```

Check the GIF in a browser, then replace `pi-session-picker-layered-demo.mp4`
and `pi-session-picker-layered-demo.gif` in this directory with the reviewed
files. Keep the raw capture and review artifacts out of Git.
