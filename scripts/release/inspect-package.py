"""Read-only release inspection using the existing package allowlist."""
import importlib.util
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('workbench_vsix_inspector', root / 'scripts/inspect-vsix.py')
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)
package = Path(sys.argv[1])
result = inspector.inspect(package)
with zipfile.ZipFile(package) as archive:
    manifest = json.loads(archive.read('extension/package.json'))
    identity = ET.fromstring(archive.read('extension.vsixmanifest')).find('{*}Metadata/{*}Identity')
    assert identity is not None, 'Missing VSIX identity'
    assert identity.attrib['Version'] == manifest['version'], 'Package and VSIX versions differ'
    assert identity.attrib['Publisher'] == manifest['publisher'], 'Package and VSIX publishers differ'
    assert identity.attrib['Id'] == manifest['name'], 'Package and VSIX names differ'
    assert identity.attrib.get('TargetPlatform') == 'win32-x64', 'Unexpected package platform'
    result.update(schemaVersion=1, target='win32-x64', extension={key: manifest[key] for key in ['name', 'publisher', 'version']})
print(json.dumps(result))
