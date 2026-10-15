#!/usr/bin/env python3
"""Pseudonymize fixture identities and move their timeline to a canonical epoch."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import sqlite3

EPOCH = datetime(2000, 1, 1, 12, tzinfo=timezone.utc).timestamp()
ID = re.compile(r'(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|(?<![A-Za-z0-9_])(?:ses|msg|prt|call|fc|toolu|req|fp|cse)_(?=[A-Za-z0-9-]*[A-Z0-9])[A-Za-z0-9-]{8,}|[0-9a-f]{40})')
DATE = re.compile(r'(?<!\d)20\d\d-\d\d-\d\d(?:T\d\d[:-]\d\d[:-]\d\d(?:[.-]\d+)?(?:Z|[+-]\d\d:\d\d)?)?')


def parsed_date(value: str) -> datetime | None:
    try:
        if 'T' in value and value.split('T')[1][2:3] == '-':
            date, clock = value.split('T')
            clock = clock[:8].replace('-', ':') + clock[8:].replace('-', '.', 1)
            value = date + 'T' + clock
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def temporal(key: str) -> bool:
    key = key.lower()
    return key in {'at', 'start', 'end', 'created', 'updated'} or any(part in key for part in ['timestamp', 'time', 'reset', 'started', 'completed', 'secs_since_epoch'])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, help='Candidate checkout; original inputs must remain available separately')
    args = parser.parse_args()
    root = args.root.resolve()
    marker = root / 'test/fixture-provenance.json'
    if marker.exists():
        parser.error('fixtures already pseudonymized; restart from the original candidate inputs')
    fixture_roots = [root / 'test' / name for name in ['fixtures', 'fixture-variants', 'job-fixtures']]
    files = sorted(p for base in fixture_roots for p in base.rglob('*') if p.is_file() and p.suffix != '.bundle')
    stamps: list[float] = []
    identities: set[str] = set()
    texts: list[str] = []

    def inspect(value, key=""):
        numeric_time = temporal(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if numeric_time and 1_577_836_800 <= value <= 1_893_456_000: stamps.append(float(value))
            elif numeric_time and 1_577_836_800_000 <= value <= 1_893_456_000_000: stamps.append(value / 1000)
        elif isinstance(value, dict):
            for field, part in value.items(): inspect(field); inspect(part, field)
        elif isinstance(value, list):
            for part in value: inspect(part, key)
        elif isinstance(value, str):
            identities.update(identity for identity in ID.findall(value) if len(set(identity)) > 1)
            for match in DATE.finditer(value):
                date = parsed_date(match[0])
                if date and date.year >= 2020: stamps.append(date.timestamp())
            if value.startswith(('{', '[')):
                try: inspect(json.loads(value))
                except (ValueError, RecursionError): pass

    for file in files:
        inspect(file.relative_to(root).as_posix())
        if file.suffix == '.db':
            with sqlite3.connect(file) as database:
                for (table,) in database.execute("select name from sqlite_master where type='table'"):
                    columns = [row[1] for row in database.execute(f'PRAGMA table_info("{table}")')]
                    for row in database.execute(f'SELECT * FROM "{table}"'):
                        for key, value in zip(columns, row): inspect(value, key)
        else:
            body = file.read_text(); texts.append(body); inspect(body)
            for line in body.splitlines():
                try: inspect(json.loads(line))
                except ValueError: pass
    if not stamps:
        parser.error('no fixture timeline found')
    shift = round(EPOCH - min(stamps))
    mapping = {}
    for identity in identities:
        digest = hashlib.sha256(('public-fixture:' + identity).encode()).hexdigest()
        if '-' in identity and '_' not in identity and len(identity) == 36:
            mapping[identity] = f'{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-a{digest[17:20]}-{digest[20:32]}'
        elif '_' in identity:
            prefix, tail = identity.split('_', 1); mapping[identity] = prefix + '_' + digest[:len(tail)]
        else: mapping[identity] = digest[:len(identity)]
    # CLI selectors can abbreviate UUIDs; update only unambiguous original prefixes.
    for width in [8, 7]:
        prefixes = {}
        for identity, replacement in list(mapping.items()):
            if len(identity) == 36:
                prefixes.setdefault(identity[:width], set()).add(replacement[:width])
        mapping.update({key: next(iter(values)) for key, values in prefixes.items() if len(values) == 1})
    for directory in (root / 'test/job-fixtures').glob('*/jobs/*'):
        if re.fullmatch('[0-9a-f]{8}', directory.name):
            mapping[directory.name] = hashlib.sha256(('public-job:' + directory.name).encode()).hexdigest()[:8]
    id_pattern = re.compile(ID.pattern + r'|\b[0-9a-f]{7,8}\b')

    number_pattern = re.compile(r'(?P<prefix>\\?"(?P<key>[A-Za-z_][A-Za-z0-9_]*)\\?"\s*:\s*)(?P<number>-?\d+(?:\.\d+)?)')

    def text(value: str) -> str:
        value = id_pattern.sub(lambda match: mapping.get(match[0], match[0]), value)
        def date(match):
            original = match[0]; parsed = parsed_date(original)
            if parsed is None or parsed.year < 2020: return original
            shifted = datetime.fromtimestamp(parsed.timestamp() + shift, parsed.tzinfo)
            if 'T' not in original: return shifted.strftime('%Y-%m-%d')
            clock = original.split('T')[1]
            dashed = clock[2:3] == '-'
            fraction = re.match(r'\d\d[:-]\d\d[:-]\d\d([.-]\d+)?', clock).group(1) or ''
            suffix = clock[8 + len(fraction):]
            return shifted.strftime('%Y-%m-%dT%H-%M-%S' if dashed else '%Y-%m-%dT%H:%M:%S') + fraction + suffix
        value = DATE.sub(date, value)
        def number(match):
            original = match['number']; value = Decimal(original)
            if not temporal(match['key']): return match[0]
            if 1_577_836_800 <= value <= 1_893_456_000: value += shift
            elif 1_577_836_800_000 <= value <= 1_893_456_000_000: value += shift * 1000
            else: return match[0]
            return match['prefix'] + format(value, 'f')
        return number_pattern.sub(number, value)

    def transform(value, key=""):
        numeric_time = temporal(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if numeric_time and 1_577_836_800 <= value <= 1_893_456_000: return value + shift
            if numeric_time and 1_577_836_800_000 <= value <= 1_893_456_000_000: return round(value + shift * 1000)
        if isinstance(value, dict): return {text(field): transform(part, field) for field, part in value.items()}
        if isinstance(value, list): return [transform(part, key) for part in value]
        if isinstance(value, str): return text(value)
        return value

    for file in files:
        if file.suffix == '.db':
            with sqlite3.connect(file) as database:
                database.execute('PRAGMA foreign_keys=OFF'); database.execute('PRAGMA secure_delete=ON')
                for (table,) in database.execute("select name from sqlite_master where type='table'").fetchall():
                    columns = [row[1] for row in database.execute(f'PRAGMA table_info("{table}")')]
                    for row in database.execute(f'SELECT rowid, * FROM "{table}"').fetchall():
                        values = [transform(value, key) for key, value in zip(columns, row[1:])]
                        assignments = ', '.join(f'"{column}"=?' for column in columns)
                        database.execute(f'UPDATE "{table}" SET {assignments} WHERE rowid=?', [*values, row[0]])
                database.commit(); database.execute('VACUUM')
        else:
            # Keep record lengths/formatting: some adapters interpolate missing times by byte offsets.
            file.write_text(text(file.read_text()))

    for base in fixture_roots:
        for path in sorted(base.rglob('*'), key=lambda p: len(p.parts), reverse=True):
            renamed = text(path.name)
            if renamed != path.name: path.rename(path.with_name(renamed))
    # Calendar directory components encode dates too, even without ISO punctuation.
    for base in fixture_roots:
        for day in sorted((path for path in base.rglob("*") if path.is_dir()), key=lambda path: len(path.parts), reverse=True):
            year, month, date = day.parts[-3:]
            if not (re.fullmatch(r"20\d\d", year) and re.fullmatch(r"\d\d", month) and re.fullmatch(r"\d\d", date)): continue
            shifted = datetime.fromtimestamp(datetime(int(year), int(month), int(date), tzinfo=timezone.utc).timestamp() + shift, timezone.utc)
            target = day.parents[2] / shifted.strftime("%Y/%m/%d")
            target.parent.mkdir(parents=True, exist_ok=True)
            day.rename(target)
        for directory in sorted((path for path in base.rglob("*") if path.is_dir()), key=lambda path: len(path.parts), reverse=True):
            if not any(directory.iterdir()): directory.rmdir()
    # Selectors refer to those same records; expected output is regenerated separately.
    file = root / 'docs/use-cases.md'
    file.write_text(text(file.read_text()))
    for file in (root / 'test').glob('*.ts'):
        file.write_text(id_pattern.sub(lambda match: mapping.get(match[0], match[0]), file.read_text()))
    marker.write_text(json.dumps({'schema':1, 'provenance':'Redacted structural adapter fixtures; identifiers pseudonymized and timeline shifted to a canonical epoch. No original ID map or date anchor is retained.', 'canonicalEpoch':'2000-01-01T12:00:00Z', 'fixtureFiles':len(files)}, indent=2) + '\n')
    print(f'Pseudonymized {len(mapping)} identity forms across {len(files)} fixture files; original timeline anchor omitted.')


if __name__ == '__main__':
    main()
