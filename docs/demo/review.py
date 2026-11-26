#!/usr/bin/env python3
"""Check the MP4 streams and extract contact sheets for manual privacy review."""

import argparse
import json
from pathlib import Path
import subprocess


def ffmpeg(*args, capture_output=False):
    return subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-n', *args],
                          capture_output=capture_output, check=True, text=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('review_dir', type=Path, help='directory populated by record.py --review-dir')
    args = parser.parse_args()
    video = str(args.video)
    review = args.review_dir
    capture = str(review/'capture.mkv')
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format',
                                               '-show_chapters', '-of', 'json', video]))
    if len(info['streams']) != 1 or info['chapters']:
        raise SystemExit('Unexpected streams or chapters in the release video')
    stream = info['streams'][0]
    if (stream['codec_type'], stream['codec_name'], stream['width'], stream['height']) != ('video', 'h264', 1440, 900):
        raise SystemExit('Expected one 1440×900 H.264 video stream (no audio)')
    for item, known_tags in [(info['format'], {'major_brand', 'minor_version', 'compatible_brands', 'encoder'}),
                             (stream, {'language', 'handler_name', 'vendor_id', 'encoder'})]:
        if unexpected := set(item.get('tags', {})) - known_tags:
            raise SystemExit(f'Unexpected metadata fields: {sorted(unexpected)}')
    print(f'Metadata check passed: {float(info["format"]["duration"]):.1f}s; H.264 only; no audio or chapters.', flush=True)

    hashes = ffmpeg('-i', capture, '-map', '0:v:0', '-f', 'framehash', '-', capture_output=True)
    frames = [line.rsplit(',', 1)[-1].strip() for line in hashes.splitlines() if line and not line.startswith('#')]
    distinct = {}
    for index, digest in enumerate(frames):
        distinct.setdefault(digest, index)
    print(f'{len(frames)} lossless frames; {len(distinct)} distinct screen states to inspect.', flush=True)
    select = '+'.join(f'eq(n\\,{index})' for index in distinct.values())
    tile = 'tile=4x3:margin=6:padding=6'
    ffmpeg('-i', capture, '-vf', f'select={select},scale=480:270,{tile}', '-fps_mode', 'vfr',
           str(review/'raw-sheet-%02d.png'))
    ffmpeg('-i', video, '-vf', f'fps=1,scale=480:300,{tile}', '-fps_mode', 'vfr',
           str(review/'final-sheet-%02d.png'))

    marks = json.loads((review/'marks.json').read_text())
    shots = {'intro': 1, 'local-preview': marks['local-jump']-1, 'local-focus': marks['remote-open']-1,
             'remote-preview': marks['remote-jump']-1, 'remote-focus': marks['done']+1}
    for label, stamp in shots.items():
        ffmpeg('-ss', str(stamp), '-i', video, '-frames:v', '1', '-update', '1', str(review/f'final-{label}.png'))
    print(f'Review all raw sheets and the final captioned frames in {review}.')


if __name__ == '__main__':
    main()
