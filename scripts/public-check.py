#!/usr/bin/env python3
"""Audit approved public files, including textual SQLite cells and binary fingerprints."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parent.parent
LOCAL = re.compile(r'/(?:home|Users)/[A-Za-z0-9_.-]+|[A-Za-z]:[\\/](?:Users|work)[\\/][A-Za-z0-9_.-]+', re.I)
SECRET = re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
PRIVATE_HOST = re.compile(r'\b[a-z0-9-]+\.tail[0-9a-z]+\.ts\.net\b', re.I)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--denylist', type=Path, help='External JSON array of private literal terms; keep outside the public tree')
    args = parser.parse_args()
    patterns = [('personal path', LOCAL), ('credential', SECRET), ('private network host', PRIVATE_HOST)]
    terms = []
    if args.denylist:
        terms = json.loads(args.denylist.read_text())
        if not isinstance(terms, list) or not terms or any(not isinstance(term, str) or not term for term in terms):
            parser.error('denylist must be a nonempty JSON array of nonempty strings')
        patterns.append(('external private term', re.compile('|'.join(re.escape(term) for term in terms), re.I)))
    manifest = json.loads((ROOT / 'export-allowlist.json').read_text())
    approved = {record['path']: record for record in manifest['files']}
    failures = []
    if len(approved) != len(manifest['files']): failures.append('duplicate approved path')
    actual = set()
    for file in ROOT.rglob('*'):
        relative = file.relative_to(ROOT)
        if relative.parts[0] in {'.git', 'node_modules', '__pycache__'} or '__pycache__' in relative.parts: continue
        if file.is_symlink(): failures.append(f'{relative}: resource symlink needs review'); continue
        if file.is_file(): actual.add(relative.as_posix())
    failures.extend(f'unapproved file: {name}' for name in sorted(actual - approved.keys()))
    failures.extend(f'missing approved file: {name}' for name in sorted(approved.keys() - actual))

    def scan(label: str, body: str, file: str) -> None:
        for kind, pattern in patterns:
            for match in pattern.finditer(body):
                # These two documented path examples exercise cross-platform display behavior.
                if kind == 'personal path' and match[0] in {'/home/example', '/Users/example'}: continue
                line = body.count('\n', 0, match.start()) + 1
                failures.append(f'{label}:{line}: {kind}')

    binary_count = 0
    for name in sorted(actual & approved.keys()):
        file = ROOT / name
        record = approved[name]
        raw = file.read_bytes()
        if record.get('approvedBinary'):
            binary_count += 1
            if hashlib.sha256(raw).hexdigest() != record['binarySha256']:
                failures.append(f'{name}: approved binary fingerprint changed')
            if record['approvedBinary'] == 'pseudonymized-sqlite':
                with sqlite3.connect(f'file:{file}?mode=ro', uri=True) as database:
                    if database.execute('PRAGMA freelist_count').fetchone()[0] != 0: failures.append(f'{name}: SQLite has unreviewed free pages')
                    tables = [row[0] for row in database.execute("select name from sqlite_master where type='table'")]
                    for table in tables:
                        for index, row in enumerate(database.execute(f'SELECT * FROM "{table}"')):
                            for value in row:
                                if isinstance(value, str): scan(f'{name}:{table}:{index}', value, name)
            elif record['approvedBinary'] != 'synthetic-git-bundle':
                failures.append(f'{name}: unknown binary approval')
            continue
        try: scan(name, raw.decode('utf-8'), name)
        except UnicodeDecodeError: failures.append(f'{name}: unapproved binary content')
    if failures:
        print('\n'.join(failures), file=sys.stderr)
        return 1
    print(f'Public boundary: {len(actual)} approved files, including {binary_count} approved binary fixtures; sensitive signatures absent.')
    if terms: print(f'External export audit: {len(terms)} private terms checked; no matches.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
