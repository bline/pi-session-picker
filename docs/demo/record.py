#!/usr/bin/env python3
"""Record the real picker in a fresh, headless Wayland session (Linux only)."""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from uuid import UUID


EXTENSION = Path(__file__).resolve().parents[2] / 'extensions/session-picker.ts'
WORKSPACES = {
    'api-reliability': ('API Reliability', [
        ('Cursor Pagination', 'Check the event feed for skipped or repeated results.',
         'Sort by timestamp and event ID to keep the cursor stable.'),
        ('Retry Audit', 'Can you check the retry logic in the queue worker?',
         'A timeout after the server commits can send the same job twice.\n\nNext: add an idempotency key and test that timeout case.'),
        ('Health Checks', 'Add a readiness endpoint for the queue worker.',
         'The readiness endpoint now checks the queue connection.'),
    ]),
    'design-system': ('Design System', [
        ('Keyboard Focus', 'Check focus order in the new settings dialog.',
         'Escape now returns focus to the settings button.'),
        ('Dialog Polish', 'Check the settings dialog at narrow widths.',
         'At narrow widths the action buttons now stack instead of overflowing.'),
        ('Design Tokens', 'Find duplicate spacing tokens.',
         'The card and modal both use the same spacing; they can share a token.'),
    ]),
    'release-ops': ('Release Ops', [
        ('Deploy Readiness', 'Review the pre-deploy checklist.',
         'The checklist now includes a worker heartbeat and a smoke check.'),
        ('CI Cache', 'Find caches the CI builds no longer need.',
         'Two jobs still restore a retired package cache.\n\nNext: remove those restores and compare CI timings.'),
        ('Rollback Drill', 'Record the result of the staging rollback drill.',
         'Staging returned to the prior build and passed its smoke checks.'),
    ]),
}
CAPTIONS = [
    ('intro', 'Three Ghostty tabs. Nine live Pi sessions.'),
    ('local-open', '01  /  Open with Left Arrow and filter with /'),
    ('local-jump', 'Enter switches tmux windows in this tab'),
    ('remote-open', '02  /  Find CI Cache in the Release Ops workspace'),
    ('remote-jump', 'Enter switches Ghostty tabs and tmux windows'),
    ('done', 'All nine Pi sessions are still running'),
]


def run(args, *, timeout=15, **kwargs):
    return subprocess.run(args, text=True, check=True, timeout=timeout, **kwargs).stdout


def until(check, description, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if result := check():
            return result
        time.sleep(.05)
    raise RuntimeError(f'Timed out: {description}')


def stop(process, sig=signal.SIGTERM):
    if process.poll() is None:
        os.killpg(process.pid, sig)
        try:
            return process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    return process.wait(timeout=5)


def fixtures(work, slug, samples, offset):
    project = work/'home'/'projects'/slug
    project.mkdir(parents=True)
    folder = work/'sessions'/('--' + str(project).strip('/').replace('/', '-') + '--')
    folder.mkdir()
    paths = []
    for index, (title, prompt, reply) in enumerate(samples, start=1):
        now = time.time() - (offset + index) * 60
        stamp = datetime.fromtimestamp(now, timezone.utc).isoformat()
        sid = str(UUID(int=offset+index))
        path = folder/f'{stamp.replace(":", "-")}_{sid}.jsonl'
        usage = dict(input=618, output=94, cacheRead=0, cacheWrite=0, totalTokens=712,
                     cost=dict(input=0, output=0, cacheRead=0, cacheWrite=0, total=0))
        entries = [
            dict(type='session', version=3, id=sid, cwd=str(project), timestamp=stamp),
            dict(type='message', id='901234ab', parentId=None, timestamp=stamp,
                 message=dict(role='user', content=prompt, timestamp=int(now*1000))),
            dict(type='message', id='901234ac', parentId='901234ab', timestamp=stamp,
                 message=dict(role='assistant', content=[dict(type='text', text=reply)],
                              api='openai-completions', provider='demo', model='demo-offline',
                              usage=usage, stopReason='stop', timestamp=int(now*1000))),
            dict(type='session_info', id='901234ad', parentId='901234ac', timestamp=stamp, name=title),
        ]
        path.write_text(''.join(json.dumps(entry)+'\n' for entry in entries))
        os.utime(path, (now, now))
        paths.append(str(path))
    return str(project), paths


class Workspace:
    def __init__(self, work, slug, label, samples, offset):
        self.label = label
        self.samples = samples
        self.command = ['tmux', '-S', str(work/f'{slug}.sock')]
        self.wrapper = work/f'attach-{slug}'
        self.project, self.paths = fixtures(work, slug, samples, offset)

    def tx(self, *args):
        return run(self.command + list(args), capture_output=True).strip()

    def start(self, pi, config):
        for index, ((title, _, _), path) in enumerate(zip(self.samples, self.paths)):
            args = ('-c', self.project, *pi, '--session', path)
            if index == 0:
                self.tx('-f', str(config), 'new-session', '-d', '-s', self.label, '-n', title, '-x', '132', '-y', '32', *args)
            else:
                self.tx('new-window', '-d', '-t', self.label+':', '-n', title, *args)
        attach = shlex.join([*self.command, 'attach-session', '-t', self.label])
        self.wrapper.write_text(f"#!/bin/sh\nprintf '\\033]0;%s\\007' {shlex.quote(self.label)}\nexec {attach}\n")
        self.wrapper.chmod(0o700)

    def pane(self, title):
        return self.tx('capture-pane', '-p', '-t', f'{self.label}:{title}')

    def keys(self, title, *keys):
        self.tx('send-keys', '-t', f'{self.label}:{title}', *keys)

    def windows(self):
        rows = self.tx('list-panes', '-s', '-t', self.label, '-F', '#{window_name}\t#{pane_id}\t#{pane_pid}')
        return {title: (pane, int(pid)) for title, pane, pid in (row.split('\t') for row in rows.splitlines())}

    def client(self):
        rows = self.tx('list-clients', '-F', '#{client_pid}\t#{window_name}\t#{client_flags}').splitlines()
        if not rows:
            return None
        if len(rows) != 1:
            raise RuntimeError(f'Expected one Ghostty client for {self.label}, found {len(rows)}')
        pid, title, flags = rows[0].split('\t')
        return int(pid), title, 'focused' in flags.split(',')

    def surface(self):
        client = self.client()
        if not client:
            return None
        # Read only the named variable from our own synthetic tmux client.
        prefix = b'GHOSTTY_SURFACE_ID='
        environ = Path(f'/proc/{client[0]}/environ').read_bytes().split(b'\0')
        return next((int(value[len(prefix):], 16) for value in environ if value.startswith(prefix)), None)

    def stop(self):
        subprocess.run(self.command + ['kill-server'], capture_output=True, timeout=5)


def setup_ghostty(action, parameter):
    # These calls only seed the layout before recording, never drive either recorded jump.
    result = run(['gdbus', 'call', '--session', '--timeout', '2', '--dest', 'com.mitchellh.ghostty',
                  '--object-path', '/com/mitchellh/ghostty', '--method', 'org.gtk.Actions.Activate',
                  action, parameter, '{}'], capture_output=True)
    if result.strip() != '()':
        raise RuntimeError(f'Unexpected Ghostty {action} reply: {result}')


def filter_picker(layer, title, scope, query, result_text):
    layer.keys(title, '/')
    until(lambda: f'Filter {scope}' in layer.pane(title), f'{scope} filter input')
    time.sleep(.25)
    for char in query:
        layer.keys(title, '-l', char)
        time.sleep(.11)
    until(lambda: result_text in layer.pane(title), f'{scope} filter match')
    layer.keys(title, 'Enter')  # Apply filter. Enter again later to select a Pi session.

    def applied():
        screen = layer.pane(title)
        return all(text in screen for text in ('Pi Sessions', f'/{query}', 'select', result_text))

    until(applied, f'{scope} filter applied')


def record(work, ghostty, pi):
    runtime = Path(os.environ['XDG_RUNTIME_DIR'])
    socket = Path(os.environ['WAYLAND_DISPLAY'])
    if runtime != work/'runtime' or socket.name != str(socket) or not (runtime/socket).is_socket():
        raise RuntimeError('Expected only the private headless compositor socket')
    if not os.environ['DBUS_SESSION_BUS_ADDRESS'].startswith('unix:'):
        raise RuntimeError('Expected the private Unix D-Bus session')
    os.environ.pop('DISPLAY', None)
    os.environ.pop('XAUTHORITY', None)
    outputs = run(['wf-recorder', '-L'], capture_output=True).splitlines()
    if len(outputs) != 1 or 'Name: HEADLESS-1 ' not in outputs[0]:
        raise RuntimeError(f'Expected exactly one private Wayland output: {outputs!r}')

    layers = [Workspace(work, slug, label, samples, index * 3)
              for index, (slug, (label, samples)) in enumerate(WORKSPACES.items())]
    api, design, release = layers
    source, local, remote = 'Cursor Pagination', 'Retry Audit', 'CI Cache'
    release_start = release.samples[0][0]
    pi += ['--offline', '--provider', 'demo', '--model', 'demo-offline', '-e', str(EXTENSION)]
    config = work/'tmux.conf'
    config.write_text('''set -g extended-keys on
set -g extended-keys-format csi-u
set -g focus-events on
set -g set-titles off
setw -g automatic-rename off
set -g status-left-length 30
set -g status-left ' #[bold]tmux / #S#[default]   '
set -g status-right ''
set -g status-interval 0
set -g status-style 'bg=#192635,fg=#c4d5ea'
setw -g window-status-format ' #I:#W '
setw -g window-status-current-format ' #[bg=#3a5677,fg=#ffffff,bold] #I:#W #[default] '
''')
    ghost = recorder = None
    try:
        for layer in layers:
            layer.start(pi, config)
        # Starting Ghostty with -e can bypass single-instance mode. Use initial-command for the first tab.
        with (Path(os.environ['XDG_CONFIG_HOME'])/'ghostty/config.ghostty').open('a') as conf:
            conf.write(f'initial-command = {shlex.quote(str(api.wrapper))}\n')
        with (work/'ghostty.log').open('wb') as log:
            # A config error opens a GTK dialog without preventing tmux from starting.
            run([ghostty, '+validate-config'], stdout=log, stderr=log)
            ghost = subprocess.Popen([ghostty, '--gtk-single-instance=true'], stdout=log, stderr=log,
                                     start_new_session=True)
        initial_surface = until(api.surface, 'API Reliability Ghostty surface')
        for layer in layers[1:]:
            argv = json.dumps(['-e', str(layer.wrapper)])
            setup_ghostty('new-tab', f'[<(uint64 {initial_surface}, {argv})>]')
            until(layer.surface, f'{layer.label} Ghostty surface')
        if len({layer.surface() for layer in layers}) != len(layers):
            raise RuntimeError('Expected three different Ghostty surfaces')
        setup_ghostty('present-surface', f'[<uint64 {initial_surface}>]')

        def current():
            return tuple(layer.client() for layer in layers)

        before_clients = until(lambda: (clients := current()) and all(
            client is not None and client[1:] == (layer.samples[0][0], layer is api)
            for layer, client in zip(layers, clients)) and clients, 'initial tab and window focus')
        before = [layer.windows() for layer in layers]
        if any(set(rows) != {sample[0] for sample in layer.samples} for layer, rows in zip(layers, before)):
            raise RuntimeError(f'Unexpected pane layout: {before!r}')
        expected = {(path, rows[title][1]) for layer, rows in zip(layers, before)
                    for (title, _, _), path in zip(layer.samples, layer.paths)}
        registry = work/'home/.cache/pi-session-picker/registry-v1'

        def registrations():
            records = [json.loads(p.read_text()) for p in registry.glob('*.json')]
            return {(record['sessionFile'], record['pid']) for record in records}

        until(lambda: registrations() == expected, 'all nine registered Pi sessions')
        for layer in layers:
            for title, prompt, _ in layer.samples:
                until(lambda: prompt in layer.pane(title), f'{title} transcript')
                if 'Warning:' in layer.pane(title):
                    raise RuntimeError(f'Unexpected Pi startup warning in {title}; not recording')
        # Pi touches resumed files at startup. Set demo-only recency after all nine are ready
        # so the picker opens on API Reliability instead of whichever Pi happened to start last.
        now = time.time()
        for index, path in enumerate(path for layer in layers for path in layer.paths):
            os.utime(path, (now - index * 5, now - index * 5))

        def snap(label, layer, title):
            (work/f'screen-{label}.txt').write_text(layer.pane(title)+'\n')

        def expect_clients(api_window, release_window, active):
            windows = (api_window, design.samples[0][0], release_window)
            return tuple((before_clients[i][0], window, layer is active)
                         for i, (layer, window) in enumerate(zip(layers, windows)))

        setup_ghostty('present-surface', f'[<uint64 {design.surface()}>]')
        until(lambda: current() == expect_clients(source, release_start, design), 'Design System intro tab')
        snap('intro', design, design.samples[0][0])
        with (work/'recorder.log').open('wb') as log:
            recorder = subprocess.Popen(['wf-recorder', '-o', 'HEADLESS-1', '--no-dmabuf', '-D', '-r', '30',
                                         '-c', 'ffv1', '-f', 'capture.mkv'], stdout=log, stderr=log, start_new_session=True)
        until(lambda: 'Output #0' in (work/'recorder.log').read_text(), 'recorder first frame')
        started = time.monotonic()
        marks = {'intro': 0}

        def mark(label):
            marks[label] = round(time.monotonic() - started, 3)

        def open_picker(title):
            api.keys(title, 'Left')

            def ready():
                screen = api.pane(title)
                return all(text in screen for text in ('Pi Sessions', 'design-system', 'Cursor Pagination', '9 active'))

            until(ready, 'unfiltered picker with API Reliability selected')

        time.sleep(2.2)
        setup_ghostty('present-surface', f'[<uint64 {initial_surface}>]')
        until(lambda: current() == before_clients, 'return to API Reliability before opening picker')
        snap('api-start', api, source)
        time.sleep(1.4)
        mark('local-open')
        time.sleep(.55)
        open_picker(source)
        time.sleep(1.25)
        api.keys(source, 'Tab')
        filter_picker(api, source, 'sessions', 'retry', 'Can you check the retry logic')
        snap('local-preview', api, source)
        time.sleep(2.25)
        mark('local-jump')
        time.sleep(.8)
        api.keys(source, 'Enter')
        until(lambda: current() == expect_clients(local, release_start, api), 'same Ghostty tab / different tmux window')
        snap('local-focus', api, local)
        time.sleep(2.7)
        mark('remote-open')
        time.sleep(.55)
        open_picker(local)
        time.sleep(.55)
        filter_picker(api, local, 'projects', 'release', 'Deploy Readiness')
        time.sleep(.4)
        api.keys(local, 'Tab')
        filter_picker(api, local, 'sessions', 'cache', 'Find caches the CI builds no longer need')
        snap('remote-preview', api, local)
        time.sleep(2.9)
        mark('remote-jump')
        time.sleep(.9)
        api.keys(local, 'Enter')
        until(lambda: current() == expect_clients(local, remote, release), 'different Ghostty tab / exact tmux window')
        if [layer.windows() for layer in layers] != before or registrations() != expected:
            raise RuntimeError('The nine original Pi pane and process identities did not survive both jumps')
        snap('remote-focus', release, remote)
        time.sleep(1.55)
        mark('done')
        time.sleep(3.35)
        if stop(recorder, signal.SIGINT) != 0:
            raise RuntimeError('Recorder failed to finish')
        (work/'marks.json').write_text(json.dumps(marks, indent=2)+'\n')
        print('Verified: same-tab switch, cross-tab and cross-window focus, and all nine original Pi sessions preserved.', flush=True)
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        for layer, titles in ((api, (source, local)), (release, (remote,))):
            for title in titles:
                try:
                    print(f'--- {layer.label} / {title} ---\n{layer.pane(title)}', file=sys.stderr)
                except subprocess.SubprocessError:
                    pass
        raise
    finally:
        if recorder is not None:
            stop(recorder, signal.SIGINT)
        if ghost is not None:
            stop(ghost)
        for layer in layers:
            layer.stop()


def encode(work):
    marks = json.loads((work/'marks.json').read_text())
    font = 'font=Lato:fontcolor=0xf4f7ff'
    filters = [
        'pad=1440:900:80:116:color=0x101823',
        'drawbox=x=78:y=114:w=1284:h=724:color=0x33485e:t=2',
        'drawbox=x=80:y=35:w=4:h=51:color=0x7ac7ff:t=fill',
        f'drawtext={font}:text=PI SESSION PICKER:fontsize=16:x=100:y=34',
        'drawtext=font=Lato:fontcolor=0x9eafc5:text=GHOSTTY + TMUX ON WAYLAND · SYNTHETIC SESSIONS:fontsize=16:x=80:y=858',
    ]
    for idx, (key, caption) in enumerate(CAPTIONS):
        start = marks[key]
        end = marks[CAPTIONS[idx+1][0]] if idx+1 < len(CAPTIONS) else 100
        filters.append(f"drawtext={font}:text='{caption}':fontsize=30:x=99:y=59:enable='gte(t,{start})*lt(t,{end})'")
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'capture.mkv', '-vf', ','.join(filters),
         '-map', '0:v:0', '-map_metadata', '-1', '-map_chapters', '-1', '-an', '-c:v', 'libx264',
         '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'demo.mp4'],
        cwd=work, timeout=90)
    info = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', 'demo.mp4'],
                          cwd=work, capture_output=True))
    stream, = info['streams']
    duration = float(info['format']['duration'])
    if (stream['codec_type'], stream['codec_name'], stream['width'], stream['height']) != ('video', 'h264', 1440, 900):
        raise RuntimeError('Unexpected video stream')
    if not marks['done'] + 2.5 <= duration <= 40:
        raise RuntimeError(f'Unexpected recording duration: {duration}s')
    print(f'Encoded {duration:.1f}s, 1440×900, H.264, one video stream (no audio).', flush=True)


def executable(value):
    resolved = shutil.which(value)
    if not resolved:
        raise SystemExit(f'Executable not found: {value!r}')
    return os.path.abspath(resolved)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='new MP4 file, outside the temporary workspace')
    parser.add_argument('--ghostty', default='ghostty', help='native Wayland Ghostty executable or AppRun')
    parser.add_argument('--pisessions', default='pisessions', help='picker-enabled pisessions executable')
    parser.add_argument('--fd', default='fd', help='fd executable (can also be fdfind)')
    parser.add_argument('--pi-command', default='pi', help='Pi command, shell-quoted if it has arguments (no shell evaluation)')
    parser.add_argument('--render-device', help='override labwc GLES DRM render node if autodetection fails')
    parser.add_argument('--review-dir', type=Path, help='new directory for raw capture, timing marks, and pane snapshots')
    args = parser.parse_args()
    paths = [p for p in (args.output, args.review_dir) if p is not None]
    if any(p.exists() or not p.parent.is_dir() for p in paths):
        parser.error('output and review directory must not exist, and their parents must exist')
    pi = shlex.split(args.pi_command)
    if not pi:
        parser.error('--pi-command must not be empty')
    pi[0] = executable(pi[0])
    ghostty, picker, fd = map(executable, (args.ghostty, args.pisessions, args.fd))
    for dependency in ('labwc', 'dbus-run-session', 'gdbus', 'wf-recorder', 'tmux', 'ffmpeg', 'ffprobe'):
        executable(dependency)
    with tempfile.TemporaryDirectory(prefix='pi-demo-', dir='/tmp') as temp:
        work = Path(temp)
        for directory in ('home', 'runtime', 'config/labwc', 'config/ghostty', 'config/pi-sessions',
                          'agent/bin', 'sessions', 'cache', 'data', 'state', 'tmp'):
            (work/directory).mkdir(mode=0o700, parents=True, exist_ok=True)
        (work/'agent/bin/fd').symlink_to(fd)
        (work/'agent/bin/rg').symlink_to(executable('rg'))
        env = dict(PATH='/usr/bin:/bin', HOME=str(work/'home'), SHELL='/bin/sh', LANG='C.UTF-8', TZ='UTC',
                   XDG_RUNTIME_DIR=str(work/'runtime'), XDG_CONFIG_HOME=str(work/'config'),
                   XDG_CACHE_HOME=str(work/'cache'), XDG_DATA_HOME=str(work/'data'), XDG_STATE_HOME=str(work/'state'),
                   XDG_SESSION_TYPE='wayland', GDK_BACKEND='wayland', GTK_USE_PORTAL='0', GTK_A11Y='none', NO_AT_BRIDGE='1',
                   XCURSOR_SIZE='1',
                   WLR_BACKENDS='headless', WLR_RENDERER='gles2', WLR_HEADLESS_OUTPUTS='1',
                   TMPDIR=str(work/'tmp'), PI_CODING_AGENT_DIR=str(work/'agent'), PI_OFFLINE='1',
                   PI_SESSION_PICKER_BIN=picker, PI_SESSIONS_ROOT=str(work/'sessions'),
                   PI_SESSIONS_THEME='textual-dark')
        if args.render_device:
            env['WLR_RENDER_DRM_DEVICE'] = args.render_device
        version = run(pi+['--version'], cwd=work, env=env, capture_output=True).strip()
        (work/'agent/settings.json').write_text(json.dumps(dict(quietStartup=True, lastChangelogVersion=version)))
        # Display-only model. It has no real credentials or reachable remote origin, and the demo sends no prompts.
        model = dict(id='demo-offline', name='Demo (offline)', contextWindow=128000, maxTokens=4096)
        demo = dict(baseUrl='http://127.0.0.1:1', api='openai-completions', apiKey='demo-not-a-key', models=[model])
        (work/'agent/models.json').write_text(json.dumps(dict(providers=dict(demo=demo))))
        (work/'config/pi-sessions/settings.json').write_text('{"check_updates": false}\n')
        (work/'config/ghostty/config.ghostty').write_text('''maximize = true
window-decoration = client
window-show-tab-bar = always
gtk-titlebar-style = tabs
font-family = DejaVu Sans Mono
font-size = 12
window-padding-x = 10
window-padding-y = 8
background = #161b22
foreground = #e0e8f2
cursor-style-blink = false
shell-integration = none
desktop-notifications = false
''')
        (work/'config/labwc/rc.xml').write_text('<labwc_config/>\n')
        actor = shlex.join([sys.executable, str(Path(__file__).resolve()), '__record', temp, ghostty, *pi])
        with (work/'labwc.log').open('wb') as log:
            compositor = subprocess.Popen(['dbus-run-session', '--', 'labwc', '-C', str(work/'config/labwc'),
                                           '-S', actor], cwd=work, env=env, stdout=log, stderr=log,
                                          start_new_session=True)
        try:
            code = compositor.wait(timeout=75)
            if code != 0 or not (work/'marks.json').is_file():
                raise RuntimeError(f'Capture did not complete (compositor exit {code})')
            # Encode outside the compositor, but use only system fonts and the isolated HOME for styling.
            saved = os.environ.copy()
            os.environ.clear()
            os.environ.update(env)
            try:
                encode(work)
            finally:
                os.environ.clear()
                os.environ.update(saved)
        except Exception:
            for name in ('labwc.log', 'ghostty.log', 'recorder.log'):
                if (work/name).is_file():
                    tail = 14000 if name == 'labwc.log' else 5000
                    print(f'--- {name} ---\n{(work/name).read_text(errors="replace")[-tail:]}', file=sys.stderr)
            raise
        finally:
            stop(compositor)
        if args.review_dir:
            args.review_dir.mkdir(mode=0o700)
            for path in [work/'capture.mkv', work/'marks.json', *sorted(work.glob('screen-*.txt'))]:
                shutil.copyfile(path, args.review_dir/path.name)
        with (work/'demo.mp4').open('rb') as src, args.output.open('xb') as dest:
            shutil.copyfileobj(src, dest)
        print(args.output.resolve())


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '__record':
        record(Path(sys.argv[2]), sys.argv[3], sys.argv[4:])
    else:
        main()
