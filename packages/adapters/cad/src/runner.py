"""Workbench CAD convention v1. Ordinary scripts receive --parameters and --output-dir.

Run with the selected isolated Python: python -I runner.py request.json.
This is a trusted-code supervisor convention, not an execution sandbox.
"""
import ast
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import runpy
import struct
import sys


def fail(code, message):
    raise CadFailure(code, message)


class CadFailure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def packages():
    return {d.metadata['Name'].lower().replace('_', '-').replace('.', '-'): d.version
            for d in importlib.metadata.distributions()}


def check_numbers(actual, expected, tolerance, label):
    if any(not math.isfinite(value) for value in actual):
        fail('CAD_GEOMETRY_INVALID', label + ' contains nonfinite values.')
    if any(abs(a - b) > tolerance for a, b in zip(actual, expected)):
        fail('CAD_TOLERANCE_FAILED', label + ' exceeds the declared tolerance.')


def dimensions(shape):
    box = shape.BoundingBox()
    return [box.xlen, box.ylen, box.zlen]


def stl_volume(path):
    data = path.read_bytes()
    if len(data) < 84:
        fail('CAD_OUTPUT_INVALID', 'STL has no complete binary header.')
    count = struct.unpack_from('<I', data, 80)[0]
    if not count or count > 1000000 or len(data) != 84 + count * 50:
        fail('CAD_OUTPUT_INVALID', 'Convention v1 requires bounded binary STL triangles.')
    volume = 0.0
    for i in range(count):
        values = struct.unpack_from('<12fH', data, 84 + i * 50)
        a, b, c = values[3:6], values[6:9], values[9:12]
        if not all(math.isfinite(x) for x in (*a, *b, *c)):
            fail('CAD_OUTPUT_INVALID', 'STL triangle contains nonfinite coordinates.')
        volume += (a[0] * (b[1]*c[2]-b[2]*c[1]) + a[1] * (b[2]*c[0]-b[0]*c[2]) + a[2] * (b[0]*c[1]-b[1]*c[0])) / 6
    return abs(volume)


def generate(request):
    if sys.prefix == sys.base_prefix and not (Path(sys.prefix) / 'conda-meta').is_dir():
        fail('CAD_ENVIRONMENT_NOT_ISOLATED', 'Select an isolated venv or conda CAD environment; global Python is not the CAD runtime.')
    import cadquery as cq
    from OCP.StlAPI import StlAPI_Reader
    from OCP.TopoDS import TopoDS_Shape

    lock = request['environment']
    actual = packages()
    if platform.python_version() != lock['python'] or actual != lock['packages']:
        fail('CAD_ENVIRONMENT_CHANGED', 'Selected Python or installed package inventory differs from the reviewed environment lock.')
    root = Path(request['snapshotRoot']).resolve()
    output = Path(request['outputDirectory']).resolve()
    source = root / request['asset']['scriptRelativePath']
    dynamic = request['asset']['dependencyDiscovery'] == 'dynamic'
    declared = {request['asset']['scriptRelativePath'], *request['asset']['localModulePaths']}
    for relative in declared:
        tree = ast.parse((root / relative).read_text(encoding='utf8'), filename=relative)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import) and any(name.name in ('importlib', 'builtins', 'runpy') or name.name.startswith('importlib.') for name in node.names):
                dynamic = True
            if isinstance(node, ast.ImportFrom) and node.module and node.module.split('.')[0] in ('importlib', 'builtins', 'runpy'):
                dynamic = True
            if isinstance(node, ast.Call) and (isinstance(node.func, ast.Name) and node.func.id in ('__import__', 'exec', 'eval') or isinstance(node.func, ast.Attribute) and node.func.attr in ('import_module', 'exec_module', 'load_module')):
                dynamic = True
    sys.path[:0] = [str(source.parent), str(root)]
    sys.argv = [str(source), '--parameters', request['parameterPath'], '--output-dir', str(output)]
    namespace = runpy.run_path(str(source), run_name='__main__')
    result = namespace.get('result')
    shape = result.val() if isinstance(result, cq.Workplane) else result
    if not isinstance(shape, cq.Shape) or not shape.isValid() or not shape.Solids():
        fail('CAD_GEOMETRY_INVALID', 'Script result must be a valid CadQuery solid or Workplane, named result.')
    settings = request['asset']['output']
    bounds, volume = dimensions(shape), shape.Volume()
    check_numbers(bounds, settings['expectedBoundsMm'], settings['boundsToleranceMm'], 'Source bounding dimensions')
    check_numbers([volume], [settings['expectedVolumeMm3']], settings['volumeToleranceMm3'], 'Source solid volume')
    for name in ('model.step', 'model.stl'):
        path = output / name
        if path.is_symlink() or path.resolve().parent != output or not path.is_file() or path.stat().st_size == 0 or path.stat().st_size > 64 * 1024 * 1024:
            fail('CAD_OUTPUT_INVALID', 'Declared outputs must be nonempty staged ordinary files up to 64 MiB.')
    step = cq.importers.importStep(str(output / 'model.step')).val()
    if not step.isValid() or not step.Solids():
        fail('CAD_OUTPUT_INVALID', 'STEP did not independently reopen as a valid solid.')
    check_numbers(dimensions(step), bounds, settings['boundsToleranceMm'], 'Reopened STEP dimensions')
    check_numbers([step.Volume()], [volume], settings['volumeToleranceMm3'], 'Reopened STEP volume')
    imported = TopoDS_Shape()
    if not StlAPI_Reader().Read(imported, str(output / 'model.stl')) or imported.IsNull():
        fail('CAD_OUTPUT_INVALID', 'STL failed the independent OCP STL reader.')
    mesh = cq.Shape.cast(imported)
    check_numbers(dimensions(mesh), bounds, settings['boundsToleranceMm'], 'Reopened STL dimensions')
    check_numbers([stl_volume(output / 'model.stl')], [volume], settings['volumeToleranceMm3'], 'Reopened STL signed triangle volume')
    return {'schemaVersion': 1, 'geometry': {'valid': True, 'boundsMm': bounds, 'volumeMm3': volume, 'stepReopened': True, 'stlReopened': True, 'stlUnit': 'mm'},
            'environment': {'python': platform.python_version(), 'packages': actual}, 'reproducible': not dynamic,
            'issues': ['Dynamic imports/code execution detected: dependency fingerprint is incomplete; caching disabled.'] if dynamic else []}


if __name__ == '__main__':
    request = json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
    report_path = Path(request['reportPath'])
    try:
        report = generate(request)
    except ModuleNotFoundError as error:
        report = {'error': {'code': 'CAD_DEPENDENCY_MISSING', 'message': 'Required Python dependency is absent: ' + str(error.name)}}
    except CadFailure as error:
        report = {'error': {'code': error.code, 'message': str(error)}}
    except Exception as error:
        report = {'error': {'code': 'CAD_GENERATION_FAILED', 'message': type(error).__name__ + ': ' + str(error)[:1000]}}
    report_path.write_text(json.dumps(report, allow_nan=False), encoding='utf8')
    if 'error' in report:
        sys.exit(1)
