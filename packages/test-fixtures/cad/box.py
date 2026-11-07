"""Synthetic design-choice box. No physical part dimensions or fit claims."""
import argparse
import json
from pathlib import Path
import cadquery as cq
from box_dimensions import thickness

parser = argparse.ArgumentParser()
parser.add_argument('--parameters', required=True)
parser.add_argument('--output-dir', required=True)
args = parser.parse_args()
parameters = json.loads(Path(args.parameters).read_text(encoding='utf8'))
result = cq.Workplane('XY').box(parameters['width']['value'], parameters['depth']['value'], thickness)
output = Path(args.output_dir)
cq.exporters.export(result, str(output / 'model.step'))
cq.exporters.export(result, str(output / 'model.stl'), tolerance=0.1, angularTolerance=0.1)
