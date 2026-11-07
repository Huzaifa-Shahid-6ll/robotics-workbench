# TASK-07 component/catalog fixtures

`synthetic.ts` defines deterministic electrical facts for software rules only.
It describes no real component, observed voltage, physical wiring or device.
The shared definition has a source-backed shape so unknown, candidate, measured,
typical and recommended facts can be tested without presenting mocks as hardware.

The built-in `arduino:uno-r3-a000066@1` reference is deliberately limited to the
published Uno R3 A000066 external logical pin aliases and mode capabilities.
Choosing it is an explicit project-intent action; no attached board is identified
automatically. A6/A7 are not exposed by this exact board reference. Electrical
limits and operating voltage remain unknown until reviewed facts are attached.

Sources checked 2026-11-02:

- Arduino [A000066 full pinout](https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf),
  dated 2022-10-06, page1. SHA256
  `088b4d7d776abf443cb050c31875221aa5fc7f0533470b33e035c249cf240007`.
  Page1 was rendered with the installed Poppler `pdftoppm` and visually inspected
  for external aliases, PWM marks and declared power direction labels.
- Official [ArduinoCore-avr1.8.8 standard pin definitions](https://raw.githubusercontent.com/arduino/ArduinoCore-avr/1.8.8/variants/standard/pins_arduino.h).
  SHA256 `d313845f9916c1f21c8ba9848d40806f5caab52529ad510e81b3f15318441631`.
  Used to cross-check A0–A5, SPI/I2C aliases and PWM-capable pin numbers.

Arduino publishes the diagram under CC-BY-SA4.0; the upstream core header carries
its LGPL2.1-or-later notice. This repository retains source attribution, hashes,
and manually reviewed pin facts, not the PDF/header itself. Temporary inspection
files are under ignored `artifacts/tmp` and are not package assets.

Catalog JSON is an array of schemaVersion1 definitions, bounded to100 definitions
and1MiB. Every definitionId/version pair is immutable. New pin maps require a
new version and an explicit migration diff; missing endpoint mappings remain
unresolved. Numeric conversions retain their original source value/unit and
cannot change dimensions or promote typical/absolute-maximum ratings to a
recommended operating guarantee.
