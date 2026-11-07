# CAD convention v1 fixture

`box.py`, `box_dimensions.py`, `parameters.json` and `assets.json` are synthetic
design choices, not physical measurements. Copy them under an ordinary project's
`mechanical` directory. Add `environment.lock.json` containing the selected Python
patch version and **complete** installed distribution inventory, with names
lowercased and underscores/dots replaced by hyphens:

```python
import importlib.metadata, json, platform
print(json.dumps({"python": platform.python_version(), "packages": {
    d.metadata["Name"].lower().replace("_", "-").replace(".", "-"): d.version
    for d in importlib.metadata.distributions()
}}))
```

Run ordinary scripts outside the workbench with the same interpreter:

```text
python mechanical/box.py --parameters mechanical/parameters.json --output-dir output
```

Create the output directory first. The convention accepts parameter objects with
value, unit, provenance basis and fitCritical; `null` remains unknown. Scripts
must expose `result` (a CadQuery Shape or Workplane), and write `model.step` and
binary `model.stl` under the supplied output directory. The service executes a
snapshot; it never rewrites the ordinary script or original parameters. Tolerance
settings describe the expected script export settings and downstream validation;
scripts must use the matching export tolerances. Headless verification checks
source validity, expected bounds/volume, independent STEP import and OCP STL
reader/triangle-volume checks. This does not establish physical fit.

Declare every local imported module. Dynamically imported/exec code is disclosed
as non-reproducible and cannot be production-exported. There is no output cache.
The complete reviewed environment lock is required; adding a viewer dependency
requires a reviewed lock update before the next generation.
