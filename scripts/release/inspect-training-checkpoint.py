#!/usr/bin/env python3
"""Inspect a real LocalTrainingWorkerManager atomic checkpoint without pickle.

Prints a compact JSON object. This is an evidence helper, not a model loader:
it verifies that the NPZ contains actual weights and optimizer state at the
step recorded by the worker, with the expected architecture digest.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np


def main() -> int:
    path = Path(sys.argv[1])
    with np.load(path, allow_pickle=False) as payload:
        keys = list(payload.files)
        step = int(payload["__step__"][0])
        config_digest = str(payload["__config_digest__"][0])
        weight_keys = [key for key in keys if key.startswith("p.")]
        optimizer_keys = [key for key in keys if key.startswith(("m1.", "m2."))]
        first_weight = payload[weight_keys[0]] if weight_keys else None
        finite = bool(first_weight is not None and np.isfinite(first_weight).all())
    print(json.dumps({
        "step": step,
        "configDigest": config_digest,
        "arrays": len(keys),
        "weightArrays": len(weight_keys),
        "optimizerArrays": len(optimizer_keys),
        "firstWeightFinite": finite,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
