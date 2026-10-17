#!/usr/bin/env python3
"""Audit approved public files, including textual SQLite cells and binary fingerprints,
and optionally the messages of commits about to be pushed or text about to be published."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import os
import sqlite3
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
LOCAL = re.compile(r'/(?:home|Users)/[A-Za-z0-9_.-]+|[A-Za-z]:[\\/](?:Users|work)[\\/][A-Za-z0-9_.-]+', re.I)
SECRET = re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
PRIVATE_HOST = re.compile(r'\b[a-z0-9-]+\.tail[0-9a-z]+\.ts\.net\b', re.I)
# The operator's private terms live beside the local catalog overrides, outside the public tree.
CONFIG = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'workflow'
DEFAULT_DENYLIST = Path(os.environ.get('WORKFLOW_PRIVATE_TERMS') or CONFIG / 'private-terms.json')


def term_pattern(terms: list[str]) -> re.Pattern[str]:
    # A term that starts or ends with a letter or digit matches whole words there only.
    edge = lambda term: (r'\b' if term[0].isalnum() else '') + re.escape(term) + (r'\b' if term[-1].isalnum() else '')
    return re.compile('|'.join(edge(term) for term in terms), re.I)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--denylist', type=Path, help=f'External JSON array of private literal terms; keep outside the public tree. Default: {DEFAULT_DENYLIST} when it exists')
    parser.add_argument('--require-denylist', action='store_true', help='Fail when no denylist is found, as the pre-push hook does')
    parser.add_argument('--commits', metavar='RANGE', action='append', default=[], help='Also scan the messages of the commits these git log revisions select, such as "a..b" or "SHA --not --remotes=origin"')
    parser.add_argument('--text', type=Path, metavar='FILE', help='Scan only this text, such as a pull request body; - reads standard input')
    args = parser.parse_args()
    patterns = [('personal path', LOCAL), ('credential', SECRET), ('private network host', PRIVATE_HOST)]
    terms = []
    denylist = args.denylist or (DEFAULT_DENYLIST if DEFAULT_DENYLIST.is_file() else None)
    if denylist:
        terms = json.loads(denylist.read_text())
        if not isinstance(terms, list) or not terms or any(not isinstance(term, str) or not term for term in terms):
            parser.error('denylist must be a nonempty JSON array of nonempty strings')
        patterns.append(('external private term', term_pattern(terms)))
    elif args.require_denylist:
        print(f'No private-term denylist at {DEFAULT_DENYLIST}. Create it as a JSON array of private terms, or set WORKFLOW_PRIVATE_TERMS.', file=sys.stderr)
        return 1
    if args.text:
        body = sys.stdin.read() if str(args.text) == '-' else args.text.read_text()
        found = [f'{args.text}:{body.count(chr(10), 0, m.start()) + 1}: {kind}' for kind, pattern in patterns for m in pattern.finditer(body)]
        if found:
            print('\n'.join(found), file=sys.stderr)
            return 1
        print(f'Text audit: {len(patterns)} pattern groups, {len(terms)} private terms; no matches.')
        return 0
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
    for revisions in args.commits:
        log = subprocess.run(['git', 'log', '--format=%H%x00%B%x00', *revisions.split()], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        parts = log.split('\0')
        for sha, message in zip(parts[0::2], parts[1::2]):
            scan(f'commit {sha.strip()[:12]} message', message, sha)
    if failures:
        print('\n'.join(failures), file=sys.stderr)
        return 1
    print(f'Public boundary: {len(actual)} approved files, including {binary_count} approved binary fixtures; sensitive signatures absent.')
    if terms: print(f'External export audit: {len(terms)} private terms checked; no matches.')
    if args.commits: print(f'Commit messages in {", ".join(args.commits)}: no matches.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
