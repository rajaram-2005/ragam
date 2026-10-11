"""Aetheris Fabric — training, evaluation and experiment control.

The Sparsiz lineage of Aetheris Omni. Responsibilities are deliberately narrow:

* keep the failure taxonomy and turn validated failures into regression tests
* score and manifest training data with deterministic, measured quality terms
* train and evaluate the Aetheris Lite retriever from scratch on NumPy
* run the improvement cycle (baseline -> experiment -> accept/reject) against an
  unchanged baseline, and record every run so it can be reproduced

It does NOT own the product surface. The five user-facing areas live in
``services/core`` and ``apps/web``; Fabric is an internal service reached
through them.
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
