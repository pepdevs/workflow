#!/usr/bin/env python3
"""Reproduce the reviewed export from a source commit and this public scaffold."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def approved_path(value: str) -> Path:
    relative = PurePosixPath(value)
    if relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts:
        raise ValueError(f'unsafe export path: {value}')
    return Path(*relative.parts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Git checkout containing the approved source files')
    parser.add_argument('destination', type=Path, help='New or empty directory; never an existing checkout')
    parser.add_argument('--revision', required=True, help='Explicit source commit; no source history is exported')
    args = parser.parse_args()
    source, destination = args.source.resolve(), args.destination.resolve()
    if destination == ROOT or destination == source or destination in source.parents or source in destination.parents:
        parser.error('destination must be separate from the source and public scaffold')
    if destination.exists() and any(destination.iterdir()):
        parser.error('destination must be empty')
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', '--verify', args.revision + '^{commit}'], text=True).strip()
    manifest = json.loads((ROOT / 'export-allowlist.json').read_text())
    pending = []
    for record in manifest['files']:
        relative = approved_path(record['path'])
        if record['origin'] == 'source':
            raw = subprocess.check_output(['git', '-C', str(source), 'show', f'{revision}:{relative.as_posix()}'])
            if hashlib.sha256(raw).hexdigest() != record['sha256']:
                parser.error(f'approved source content changed: {relative}')
        elif record['origin'] == 'public':
            public = ROOT / relative
            if public.is_symlink() or not public.is_file():
                parser.error(f'public scaffold file is unavailable: {relative}')
            raw = public.read_bytes()
        else:
            parser.error(f'unknown file origin: {relative}')
        pending.append((relative, raw, record['mode']))
    destination.mkdir(parents=True, exist_ok=True)
    for relative, raw, mode in pending:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        target.chmod(int(mode, 8))
    print(f'Exported {len(pending)} approved files without Git history.')


if __name__ == '__main__':
    main()
