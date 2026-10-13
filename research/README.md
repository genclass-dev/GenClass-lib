# research/

Earlier GenClass/Jev research: a voice-control Chrome extension (`extension/`), the typed-decision encoder and
Jev-compatible server it ran on (`jev_local/`, a Python package; `pyproject.toml`, `tests/`), its classifier
benchmarks (`BENCHMARKS.md`, `scripts/`) and the build contract of that project (`docs/CONTRACT.md`).
Not part of `@genclass/runtime`. See [GENCLASS.md](GENCLASS.md) for what it was.

`visual/` is newer and unrelated to Jev: [visual/CATALOG.md](visual/CATALOG.md) ranks visual and CSS bugs found in
AI-generated web apps, with evidence, detection and fixes, and [visual/injectors.json](visual/injectors.json) holds the
matching fault-injection recipes for a visual-check bench. They feed the visual checks designed in
`docs/runtime/VISUAL.md` (branch `wave2/visual`).

`training/` (the runtime model) still imports `jev_local` for the encoder, tokenizer packing and calibration; the
training scripts sync this directory to the training nodes. To use it locally:

```bash
cd research && python -m venv .venv && .venv/bin/pip install -e .
```
