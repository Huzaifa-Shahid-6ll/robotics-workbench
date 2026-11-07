#!/usr/bin/env python3
"""Read an authoritative specification by stable ID: python scripts/read_doc.py D18.
Use --list to print the index. This command does not load unrelated context.
"""
import argparse
import json
from pathlib import Path

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('doc_id',nargs='?')
parser.add_argument('--list',action='store_true')
args=parser.parse_args()
docs=json.loads((root/'doc-manifest.json').read_text(encoding='utf-8'))['documents']
if args.list:
    print('\n'.join(f'{d["id"]}\t{d["path"]}' for d in docs))
elif args.doc_id:
    matches=[d for d in docs if d['id']==args.doc_id.upper()]
    if not matches:parser.error('Unknown document ID; use --list')
    print((root/matches[0]['path']).read_text(encoding='utf-8'))
else:parser.error('Supply a document ID or --list')
