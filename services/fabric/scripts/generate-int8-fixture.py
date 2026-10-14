#!/usr/bin/env python3
"""Regenerate the small int8 cross-language fixture from the existing float fixture.

No training, network calls or released weights. Run from the repository root:
  .venv/bin/python services/fabric/scripts/generate-int8-fixture.py
"""
import base64
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fabric.lm.quantize import load_source, quantize_parameters, quantize_artifact  # noqa: E402
from fabric.lm.export import write_json  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "services/core/test/fixtures"


def main():
    original = json.loads((FIXTURES / "klyvaron-lite-parity.json").read_text())
    with TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source"
        source.mkdir()
        (source / "tiny.klyvaron.json").write_text(json.dumps(original["manifest"]))
        (source / original["manifest"]["weights"]["file"]).write_bytes(base64.b64decode(original["npzBase64"]))
        text = "Aetheris Klyvaron " * 32
        report = quantize_artifact(source, root / "int8", version="0.1.0-int8-fixture", validation_text=text,
                                   max_nll_increase=0.02, max_disagreement=0.05)
        if report["status"] != "passed":
            raise RuntimeError(report)
        manifest = json.loads(next((root / "int8").glob("*.klyvaron.json")).read_text())
        _, reference, tokenizer, _ = load_source(source)
        _, reference.params = quantize_parameters(reference.params)
        cases = []
        for prompt in ("Aetheris", "Klyvaron ", " ", "\nAetheris "):
            ids = tokenizer.encode(prompt)
            logits = reference.forward(ids[None, :])[0, -1]
            window = list(ids)
            generated = []
            for _ in range(12):
                next_id = int(reference.forward(np.asarray(window[-reference.config.seq_len:], dtype=np.int32)[None, :])[0, -1].argmax())
                window.append(next_id)
                generated.append(next_id)
            cases.append({"prompt": prompt, "ids": ids.tolist(), "logits": logits.tolist(), "greedyIds": generated})
        write_json(FIXTURES / "klyvaron-lite-int8-parity.json", {
            "notice": "Random-initialized test weights, not a trained or released assistant. NumPy dequantized reference vs resident-int8 Node CPU inference.",
            "generatedBy": "services/fabric/scripts/generate-int8-fixture.py",
            "manifest": manifest, "report": report, "cases": cases,
            "npzBase64": base64.b64encode((root / "int8" / manifest["weights"]["file"]).read_bytes()).decode(),
        })
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
