#!/usr/bin/env python3
"""Validate this specification pack, not the future application.

Standard library checks always run. --contracts additionally requires jsonschema.
Exit 0 means selected checks passed; it never certifies hardware or implementation.
"""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contracts', action='store_true', help='Require Draft 2020-12 fixture validation')
    parser.add_argument('--report', help='Optional JSON report path')
    args = parser.parse_args()
    errors, warnings = [], []
    manifest = json.loads((ROOT/'doc-manifest.json').read_text(encoding='utf-8'))
    docs = manifest['documents']
    ids = {d['id'] for d in docs}
    if len(docs)!=50 or ids!={f'D{i:02}' for i in range(1,51)}:
        errors.append('Document manifest must contain D01..D50 exactly once')
    indexed = []
    for d in docs:
        path = ROOT/d['path']
        if not path.is_file():
            errors.append(f'Missing {d["path"]}'); continue
        content = path.read_text(encoding='utf-8')
        if not re.search(r'^doc_id:\s*[\"\']?'+d['id']+r'[\"\']?\s*$', content, re.M):
            errors.append(f'{d["id"]}: missing/mismatched doc_id')
        if not content.startswith('---\n'):
            errors.append(f'{d["id"]}: missing YAML frontmatter')
        for field in ['title','status','updated','depends_on','requirement_ids']:
            if not re.search(r'^'+field+r':', content, re.M):
                errors.append(f'{d["id"]}: missing {field}')
        dependencies=re.search(r'^depends_on:\s*\[([^\]]*)\]',content,re.M)
        if dependencies:
            for dependency in re.findall(r'\bD\d+\b',dependencies.group(1)):
                if dependency not in ids:errors.append(f'{d["id"]}: unknown document dependency {dependency}')
        acs=sorted(set(re.findall(r'\bAC-'+d['id']+r'-\d+\b',content)))
        if not acs: errors.append(f'{d["id"]}: no owned acceptance criteria')
        if len(content.split())<350: warnings.append(f'{d["id"]}: shorter than 350 words; review intentionally')
        prose=re.sub(r'```.*?```','',content,flags=re.S)
        for target in re.findall(r'\]\(([^)]+)\)',prose):
            target=target.strip('<> ').split(' "')[0]
            if re.match(r'^(?:[a-z]+:|#)',target,re.I):continue
            target=unquote(target.split('#')[0])
            if target and not (path.parent/target).exists(): errors.append(f'{d["id"]}: broken link {target}')
        indexed.append({'id':d['id'],'path':d['path'],'words':len(content.split()),'acceptance_criteria':acs,'requirement_references':sorted(set(re.findall(r'\bREQ-[A-Z]+-(?:\d+-)*\d+\b',content)))})
    json_count=0
    # Inspect specification assets, not installed dependencies or generated app data.
    json_paths = list(ROOT.glob('*.json'))
    for directory in ('contracts', 'examples', 'references', 'tasks'):
        json_paths.extend((ROOT/directory).rglob('*.json'))
    for path in json_paths:
        if path.name=='validation-report.json':continue
        try:json.loads(path.read_text(encoding='utf-8'));json_count+=1
        except (ValueError,UnicodeError) as e:errors.append(f'Invalid JSON {path.relative_to(ROOT)}: {e}')
    fixture_count=0
    if args.contracts:
        try:from jsonschema import Draft202012Validator, FormatChecker
        except ImportError:
            errors.append('Install scripts/requirements-validation.txt to use --contracts')
        else:
            fixture_manifest=json.loads((ROOT/'contracts/fixture-manifest.json').read_text())
            for path in (ROOT/'contracts').glob('*.schema.json'):
                try:Draft202012Validator.check_schema(json.loads(path.read_text()))
                except Exception as e:errors.append(f'Invalid schema {path.name}: {e}')
            for case in fixture_manifest['fixtures']:
                schema=json.loads((ROOT/'contracts'/case['schema']).read_text())
                fixture=json.loads((ROOT/'contracts'/case['file']).read_text())
                validator=Draft202012Validator(schema,format_checker=FormatChecker())
                failures=list(validator.iter_errors(fixture))
                actual='invalid' if failures else 'valid'
                if actual!=case['expected']:
                    errors.append(f'{case["file"]}: expected {case["expected"]}, got {actual}; '+ '; '.join(e.message for e in failures))
                fixture_count+=1
    transitions=json.loads((ROOT/'examples/state-transitions.json').read_text())
    states=set(transitions['allowed'])
    canonical={'queued','running','awaiting-input','succeeded','failed','cancelled','outcome-unknown'}
    if states!=canonical:errors.append('Operation states differ from canonical vocabulary')
    for state,next_states in transitions['allowed'].items():
        if not set(next_states)<=states:errors.append(f'Unknown transition from {state}')
        if state in transitions['terminal'] and next_states:errors.append(f'Terminal transition from {state}')
    task_count=0
    task_path=ROOT/'tasks/task-index.json'
    if task_path.exists():
        data=json.loads(task_path.read_text())
        tasks=data.get('tasks',data.get('packets',[]))
        task_count=len(tasks)
        task_ids={t.get('task_id',t.get('id')) for t in tasks}
        if len(task_ids)!=task_count:errors.append('Task IDs must be unique')
        all_acs={ac for d in indexed for ac in d['acceptance_criteria']}
        edges={}
        for task in tasks:
            tid=task.get('task_id',task.get('id'))
            deps=task.get('depends_on',[]);edges[tid]=deps
            for dep in deps:
                if dep not in task_ids:errors.append(f'{tid}: unknown prerequisite {dep}')
            for docid in task.get('read',[]):
                if docid not in ids:errors.append(f'{tid}: unknown read document {docid}')
            for ac in task.get('acceptance',[]):
                if ac not in all_acs:errors.append(f'{tid}: unknown acceptance {ac}')
        def visit(node,chain,done):
            if node in chain:
                errors.append('Task dependency cycle: '+' -> '.join(chain+[node]));return
            if node in done:return
            for dep in edges.get(node,[]):visit(dep,chain+[node],done)
            done.add(node)
        done=set()
        for tid in task_ids:visit(tid,[],done)
    report={'scope':'Documentation structure, local links, JSON syntax, selected contract fixtures, declared operation-state vocabulary and task references/DAG only','implementation_tested':False,'hardware_tested':False,'passed':not errors,'documents_checked':len(indexed),'json_files_checked':json_count,'contract_fixtures_checked':fixture_count,'task_packets_checked':task_count,'errors':errors,'warnings':warnings,'document_index':indexed}
    if args.report:Path(args.report).write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='document_index'},indent=2))
    return 1 if errors else 0

if __name__=='__main__':sys.exit(main())
