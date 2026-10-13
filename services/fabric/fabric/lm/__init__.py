"""Aetheris Lite: a language model trained from scratch in pure NumPy.

No pretrained weights, no PyTorch, no GPU, no network. This package exists because
the alternative -- fine-tuning someone else's checkpoint -- was blocked on weights
that cannot be downloaded in this environment, while training from nothing needs
only compute and a corpus, both of which are available.

What it is: a real, reproducible, versioned, evaluated artifact.
What it is not: a good language model. A few hundred thousand parameters trained on
1.5 MB of source text produces text shaped like the corpus and mostly not meaningful.
`docs/08-aetheris-lite.md` records that as a known limitation rather than dressing it
up, and the evaluation always reports real baselines (uniform, unigram, bigram) so
the model's quality can be compared with something rather than asserted.
"""
