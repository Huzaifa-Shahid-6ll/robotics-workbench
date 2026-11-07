"""Create a clearly synthetic, manifest-only VSIX version for isolated maintenance tests."""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
import uuid
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = ('local-workbench', 'robotics-workbench')


def owned_root(value):
    supplied = Path(value).absolute()
    canonical = supplied.resolve(strict=True)
    base = (ROOT / 'artifacts' / 'task12-maintenance').resolve(strict=True)
    assert canonical.parent == base and uuid.UUID(canonical.name), 'Use a unique owned maintenance run.'
    assert os.path.normcase(str(supplied)) == os.path.normcase(str(canonical)), 'Linked run roots are refused.'
    return canonical


def inventory(archive):
    entries = archive.infolist()
    assert len(entries) <= 500 and len({item.filename for item in entries}) == len(entries), 'Invalid VSIX entry inventory.'
    assert sum(item.file_size for item in entries) <= 256 * 1024 * 1024, 'VSIX exceeds fixture byte bound.'
    for item in entries:
        assert item.filename and not item.filename.startswith(('/', '\\')) and '\\' not in item.filename
        assert '..' not in item.filename.split('/') and not item.flag_bits & 1
        assert item.file_size <= 128 * 1024 * 1024 and not item.is_dir()
    return {item.filename: archive.read(item) for item in entries}


def create(source, destination, run_root):
    run_root = owned_root(run_root)
    destination = Path(destination).absolute()
    assert destination.parent == run_root and not destination.exists(), 'Fixture output must be new and inside its run.'
    source = Path(source).resolve(strict=True)
    assert source != destination and source.stat().st_size <= 128 * 1024 * 1024
    with zipfile.ZipFile(source) as archive:
        original = inventory(archive)
    package = json.loads(original['extension/package.json'])
    assert (package['publisher'], package['name']) == IDENTITY and package['version'] != '0.0.0'
    original_version = package['version']
    package['version'] = '0.0.0'
    manifest = ET.fromstring(original['extension.vsixmanifest'])
    identity = manifest.find('.//{*}Identity')
    assert identity is not None
    assert (identity.attrib['Publisher'], identity.attrib['Id'], identity.attrib['Version']) == (*IDENTITY, original_version)
    identity.set('Version', '0.0.0')
    if manifest.tag.startswith('{'):
        ET.register_namespace('', manifest.tag[1:].split('}')[0])
    altered = dict(original)
    altered['extension/package.json'] = (json.dumps(package, indent=2) + '\n').encode('utf-8')
    altered['extension.vsixmanifest'] = ET.tostring(manifest, encoding='utf-8', xml_declaration=True)
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in altered.items():
            archive.writestr(name, data)
    with zipfile.ZipFile(destination) as archive:
        actual = inventory(archive)
    changed = [name for name in original if actual[name] != original[name]]
    assert sorted(changed) == ['extension.vsixmanifest', 'extension/package.json']
    digest = lambda data: hashlib.sha256(data).hexdigest()
    return {'schemaVersion': 1, 'fixture': True, 'purpose': 'Same-code manifest-only synthetic version; never a historical release.', 'pythonVersion': sys.version.split()[0], 'originalVersion': original_version, 'fixtureVersion': '0.0.0', 'originalSha256': digest(source.read_bytes()), 'fixtureSha256': digest(destination.read_bytes()), 'changedEntries': sorted(changed), 'runtimeUnchanged': True, 'runtimeFiles': [{'path': name.removeprefix('extension/'), 'sha256': digest(data)} for name, data in original.items() if name.startswith(('extension/dist/', 'extension/media/'))]}


def self_test(run_root):
    run_root = owned_root(run_root)
    source = run_root / 'synthetic-input.vsix'
    package = {'publisher': IDENTITY[0], 'name': IDENTITY[1], 'version': '0.1.0'}
    manifest = b'<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Publisher="local-workbench" Id="robotics-workbench" Version="0.1.0"/></Metadata></PackageManifest>'
    with zipfile.ZipFile(source, 'x') as archive:
        archive.writestr('extension/package.json', json.dumps(package))
        archive.writestr('extension.vsixmanifest', manifest)
        archive.writestr('extension/dist/extension.js', b'// SYNTHETIC unchanged runtime\n')
    destination = run_root / 'synthetic-output.vsix'
    result = create(source, destination, run_root)
    assert result['runtimeUnchanged'] and len(result['changedEntries']) == 2
    before = destination.read_bytes()
    try:
        create(source, destination, run_root)
        raise RuntimeError('Existing fixture was overwritten.')
    except AssertionError:
        assert destination.read_bytes() == before
    try:
        create(source, run_root.parent / 'outside.vsix', run_root)
        raise RuntimeError('Outside output was accepted.')
    except AssertionError:
        pass
    hostile = run_root / 'hostile-input.vsix'
    with zipfile.ZipFile(hostile, 'x') as archive:
        archive.writestr('../outside', 'untrusted')
    try:
        create(hostile, run_root / 'hostile-output.vsix', run_root)
        raise RuntimeError('Traversal VSIX was accepted.')
    except AssertionError:
        pass
    return {'result': 'passed', 'pythonVersion': sys.version.split()[0], 'checks': ['Only version manifests change; runtime bytes are identical.', 'Existing output is preserved.', 'Outside output is refused.', 'Traversal archive is refused before writing output.'], 'limitations': ['Synthetic ZIP only; no Code process or installation was launched.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-root', required=True)
    parser.add_argument('--source')
    parser.add_argument('--output')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        assert not args.source and not args.output
        result = self_test(args.run_root)
    else:
        assert args.source and args.output
        result = create(args.source, args.output, args.run_root)
    print(json.dumps(result))
