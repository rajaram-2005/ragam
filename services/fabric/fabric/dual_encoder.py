"""Aetheris Lite dual-encoder retriever, implemented from scratch on NumPy.

Why from scratch
----------------
This host has no GPU, no ``torch`` and no route to ``download.pytorch.org`` or
``huggingface.co``, so no pretrained weights can be fetched and no LoRA/QLoRA run
can be executed. Rather than ship an adapter around a model that cannot be
installed — which would make every claim about it unverifiable — this module
trains a small dense retriever end to end on the CPU that is actually present.
Forward pass, loss and gradients are all written out, and
``tests/test_dual_encoder.py`` checks every gradient against a central finite
difference. If the maths were wrong, that test would fail.

Architecture
------------
A dual encoder with a shared token embedding table and separate query/document
projections::

    tokens -> E[token] -> mean-pool -> h            (d_model)
    z_q = l2_normalize(h_q @ Wq + bq)                (d_emb)
    z_d = l2_normalize(h_d @ Wd + bd)                (d_emb)
    score(q, d) = z_q . z_d                          cosine, in [-1, 1]

Trained with InfoNCE: for each query in a batch, the positives are its own
document, the negatives are every other document in the batch plus one hard
negative mined from BM25. Temperature is a fixed scale on the logits.

What this model is *not*
------------------------
It is a retriever. It does not generate text, and it is not a competitor to
Mistral, Qwen, Llama, Gemma or DeepSeek on any generation benchmark. The
comparison recorded in the experiment ledger is against BM25 over the same
corpus with the same tokeniser, which is the system it is meant to improve on.
Claiming more than that would be exactly the kind of unsupported superiority
claim the project brief forbids.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field

import numpy as np

from .text import stem_tokens

__all__ = ["Vocabulary", "DualEncoderConfig", "DualEncoder", "Batch", "TrainingEpoch"]

UNK = "<unk>"
PAD = "<pad>"


class Vocabulary:
    """Stemmed-token vocabulary with explicit UNK and PAD slots."""

    def __init__(self, tokens: list[str] | None = None) -> None:
        self._ids: dict[str, int] = {PAD: 0, UNK: 1}
        self._tokens: list[str] = [PAD, UNK]
        for token in tokens or []:
            self.add(token)

    def add(self, token: str) -> int:
        if token in self._ids:
            return self._ids[token]
        index = len(self._tokens)
        self._ids[token] = index
        self._tokens.append(token)
        return index

    def __len__(self) -> int:
        return len(self._tokens)

    def __contains__(self, token: object) -> bool:
        return token in self._ids

    @property
    def unk_id(self) -> int:
        return self._ids[UNK]

    @property
    def pad_id(self) -> int:
        return self._ids[PAD]

    @property
    def tokens(self) -> list[str]:
        return list(self._tokens)

    def encode(self, text: str, *, max_tokens: int | None = None) -> list[int]:
        ids = [self._ids.get(token, self.unk_id) for token in stem_tokens(text)]
        return ids[:max_tokens] if max_tokens else ids

    def build(self, texts, *, min_df: int = 1) -> "Vocabulary":
        """Grow the vocabulary from a corpus, dropping terms below ``min_df``."""
        counts: dict[str, int] = {}
        for text in texts:
            for token in dict.fromkeys(stem_tokens(text)):
                counts[token] = counts.get(token, 0) + 1
        for token in sorted(token for token, count in counts.items() if count >= min_df):
            self.add(token)
        return self

    def to_dict(self) -> dict:
        return {"tokens": self._tokens}

    @classmethod
    def from_dict(cls, data: dict) -> "Vocabulary":
        vocabulary = cls()
        for token in data["tokens"][2:]:
            vocabulary.add(token)
        return vocabulary

    def digest(self) -> str:
        encoded = json.dumps(self._tokens, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:16]


@dataclass
class DualEncoderConfig:
    """Everything needed to reproduce a run. Recorded verbatim in the run record."""

    d_model: int = 64
    d_emb: int = 32
    scale: float = 12.0
    learning_rate: float = 0.02
    batch_size: int = 16
    epochs: int = 12
    max_tokens: int = 96
    #: Adam hyperparameters.
    beta1: float = 0.9
    beta2: float = 0.999
    epsilon: float = 1e-8
    weight_decay: float = 0.0
    #: Weight of the hard-negative column relative to in-batch negatives.
    hard_negative_weight: float = 1.0
    seed: int = 0
    gradient_clip: float = 5.0

    def as_dict(self) -> dict:
        return {
            "d_model": self.d_model,
            "d_emb": self.d_emb,
            "scale": self.scale,
            "learning_rate": self.learning_rate,
            "batch_size": self.batch_size,
            "epochs": self.epochs,
            "max_tokens": self.max_tokens,
            "beta1": self.beta1,
            "beta2": self.beta2,
            "epsilon": self.epsilon,
            "weight_decay": self.weight_decay,
            "hard_negative_weight": self.hard_negative_weight,
            "seed": self.seed,
            "gradient_clip": self.gradient_clip,
        }

    def digest(self) -> str:
        encoded = json.dumps(self.as_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:16]


@dataclass
class Batch:
    """One training batch: matched (query, positive, hard-negative) triples."""

    query_ids: np.ndarray      # [B, Lq]
    query_mask: np.ndarray     # [B, Lq]
    pos_ids: np.ndarray        # [B, Ld]
    pos_mask: np.ndarray       # [B, Ld]
    neg_ids: np.ndarray | None  # [B, Ld] or None
    neg_mask: np.ndarray | None

    @property
    def size(self) -> int:
        return int(self.query_ids.shape[0])


@dataclass
class TrainingEpoch:
    epoch: int
    loss: float
    accuracy: float
    lr: float
    seconds: float
    batches: int


def _pad(rows: list[list[int]], pad_id: int) -> tuple[np.ndarray, np.ndarray]:
    """Pad a list of id sequences into (ids, mask)."""
    # max(1, ...) matters: a batch in which every sequence is empty would
    # otherwise get width 0, and the empty-row branch below would write to a
    # column that does not exist.
    width = max(1, max((len(row) for row in rows), default=1))
    ids = np.full((len(rows), width), pad_id, dtype=np.int64)
    mask = np.zeros((len(rows), width), dtype=np.float64)
    for index, row in enumerate(rows):
        if row:
            ids[index, : len(row)] = row
            mask[index, : len(row)] = 1.0
        else:
            # An empty sequence still needs one attended slot, otherwise the mean
            # pool divides by zero. PAD's embedding is free to absorb it.
            mask[index, 0] = 1.0
    return ids, mask


class DualEncoder:
    """Cosine-similarity dual encoder with an InfoNCE objective."""

    PARAMETER_NAMES = ("E", "Wq", "bq", "Wd", "bd")

    def __init__(self, vocabulary: Vocabulary, config: DualEncoderConfig | None = None) -> None:
        self.vocab = vocabulary
        self.config = config or DualEncoderConfig()
        self._rng = np.random.default_rng(self.config.seed)

        vocab_size = len(vocabulary)
        scale = 1.0 / math.sqrt(self.config.d_model)
        self.E = self._rng.normal(0.0, scale, size=(vocab_size, self.config.d_model))
        self.Wq = self._rng.normal(0.0, scale, size=(self.config.d_model, self.config.d_emb))
        self.bq = np.zeros(self.config.d_emb)
        self.Wd = self._rng.normal(0.0, scale, size=(self.config.d_model, self.config.d_emb))
        self.bd = np.zeros(self.config.d_emb)

        self._adam = {name: (np.zeros_like(getattr(self, name)), np.zeros_like(getattr(self, name))) for name in self.PARAMETER_NAMES}
        self._step = 0
        self.history: list[TrainingEpoch] = []

    # --- parameter access -------------------------------------------------

    def parameters(self) -> dict[str, np.ndarray]:
        return {name: getattr(self, name) for name in self.PARAMETER_NAMES}

    def parameter_count(self) -> int:
        return int(sum(value.size for value in self.parameters().values()))

    # --- forward ----------------------------------------------------------

    @staticmethod
    def _l2_normalize(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        safe = np.maximum(norms, 1e-12)
        return matrix / safe, norms

    def pool(self, ids: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """Mean-pool token embeddings over attended positions."""
        embedded = self.E[ids]                      # [B, L, dm]
        weights = mask[:, :, None]
        summed = (embedded * weights).sum(axis=1)    # [B, dm]
        counts = np.maximum(mask.sum(axis=1, keepdims=True), 1.0)
        return summed / counts

    def encode_query(self, ids: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Returns (z_q, norm) where z_q is unit length."""
        h = self.pool(ids, mask)
        u = h @ self.Wq + self.bq
        return self._l2_normalize(u)

    def encode_document(self, ids: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        h = self.pool(ids, mask)
        u = h @ self.Wd + self.bd
        return self._l2_normalize(u)

    def encode_texts(self, texts: list[str], *, side: str = "document") -> np.ndarray:
        """Convenience: encode raw strings to unit vectors."""
        rows = [self.vocab.encode(text, max_tokens=self.config.max_tokens) or [self.vocab.pad_id] for text in texts]
        ids, mask = _pad(rows, self.vocab.pad_id)
        if side == "query":
            return self.encode_query(ids, mask)[0]
        if side == "document":
            return self.encode_document(ids, mask)[0]
        raise ValueError("side must be 'query' or 'document'")

    def similarity(self, query_vectors: np.ndarray, document_vectors: np.ndarray) -> np.ndarray:
        """Full cosine matrix between two sets of unit vectors."""
        return query_vectors @ document_vectors.T

    # --- loss -------------------------------------------------------------

    def logits(self, batch: Batch) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
        """Build the [B, B(+1)] logit matrix. Column i is query i against document i."""
        z_q, _ = self.encode_query(batch.query_ids, batch.query_mask)
        z_d, _ = self.encode_document(batch.pos_ids, batch.pos_mask)
        matrix = (z_q @ z_d.T) * self.config.scale
        z_neg = None
        if batch.neg_ids is not None:
            z_neg, _ = self.encode_document(batch.neg_ids, batch.neg_mask)
            hard = ((z_q * z_neg).sum(axis=1, keepdims=True)) * self.config.scale
            matrix = np.concatenate([matrix, hard * self.config.hard_negative_weight], axis=1)
        return matrix, z_q, z_neg

    def loss(self, batch: Batch) -> float:
        matrix, _, _ = self.logits(batch)
        labels = np.arange(batch.size)
        shifted = matrix - matrix.max(axis=1, keepdims=True)
        exp = np.exp(shifted)
        denominator = exp.sum(axis=1)
        picked = exp[np.arange(batch.size), labels]
        return float(-np.log(np.maximum(picked / denominator, 1e-12)).mean())

    def accuracy(self, batch: Batch) -> float:
        """Fraction of queries whose positive outranks every negative in the batch."""
        matrix, _, _ = self.logits(batch)
        return float((matrix.argmax(axis=1) == np.arange(batch.size)).mean())

    # --- backward ---------------------------------------------------------

    def gradients(self, batch: Batch) -> dict[str, np.ndarray]:
        """Exact gradients of the InfoNCE loss with respect to every parameter.

        The logit matrix is [B, B] for in-batch negatives plus one extra column for
        the per-query hard negative. Note that the hard column cannot be built by
        concatenating embedding matrices: it is a rowwise dot product, so each query
        is scored against *its own* negative, not against every negative.
        """
        size = batch.size
        labels = np.arange(size)
        scale = self.config.scale
        weight = self.config.hard_negative_weight

        h_q = self.pool(batch.query_ids, batch.query_mask)
        u_q = h_q @ self.Wq + self.bq
        z_q, norm_q = self._l2_normalize(u_q)

        h_d = self.pool(batch.pos_ids, batch.pos_mask)
        u_d = h_d @ self.Wd + self.bd
        z_d, norm_d = self._l2_normalize(u_d)

        h_neg = z_neg = norm_neg = None
        in_batch = z_q @ z_d.T
        if batch.neg_ids is not None:
            h_neg = self.pool(batch.neg_ids, batch.neg_mask)
            u_neg = h_neg @ self.Wd + self.bd
            z_neg, norm_neg = self._l2_normalize(u_neg)
            hard = (z_q * z_neg).sum(axis=1, keepdims=True) * weight
            matrix = np.concatenate([in_batch, hard], axis=1) * scale
        else:
            matrix = in_batch * scale

        shifted = matrix - matrix.max(axis=1, keepdims=True)
        exp = np.exp(shifted)
        probabilities = exp / exp.sum(axis=1, keepdims=True)
        # Cross-entropy with one-hot labels: d(loss)/d(matrix).
        dmatrix = probabilities - np.eye(size, matrix.shape[1])
        dmatrix = dmatrix / size

        def unnormalize(dz: np.ndarray, z: np.ndarray, norms: np.ndarray) -> np.ndarray:
            # z = u / ||u||  =>  du = (dz - z * (dz . z)) / ||u||
            dot = (dz * z).sum(axis=1, keepdims=True)
            return (dz - z * dot) / np.maximum(norms, 1e-12)

        grads = {"Wq": np.zeros_like(self.Wq), "bq": np.zeros_like(self.bq),
                 "Wd": np.zeros_like(self.Wd), "bd": np.zeros_like(self.bd),
                 "E": np.zeros_like(self.E)}

        # --- in-batch block: matrix[:, :size] = scale * (z_q @ z_d.T) --------
        d_inbatch = dmatrix[:, :size] * scale
        d_zq = d_inbatch @ z_d
        d_zd = d_inbatch.T @ z_q

        # --- hard-negative column: matrix[:, size] = scale * weight * rowdot --
        if z_neg is not None:
            d_hard = dmatrix[:, size:] * scale * weight          # [B, 1]
            d_zq = d_zq + d_hard * z_neg
            d_zneg = d_hard * z_q
            d_uneg = unnormalize(d_zneg, z_neg, norm_neg)
            grads["Wd"] += h_neg.T @ d_uneg
            grads["bd"] += d_uneg.sum(axis=0)
            self._scatter(grads, "E", batch.neg_ids, batch.neg_mask, d_uneg @ self.Wd.T)

        d_uq = unnormalize(d_zq, z_q, norm_q)
        d_ud = unnormalize(d_zd, z_d, norm_d)

        grads["Wq"] += h_q.T @ d_uq
        grads["bq"] += d_uq.sum(axis=0)
        grads["Wd"] += h_d.T @ d_ud
        grads["bd"] += d_ud.sum(axis=0)

        self._scatter(grads, "E", batch.query_ids, batch.query_mask, d_uq @ self.Wq.T)
        self._scatter(grads, "E", batch.pos_ids, batch.pos_mask, d_ud @ self.Wd.T)

        if self.config.weight_decay:
            for name in ("Wq", "Wd", "E"):
                grads[name] = grads[name] + self.config.weight_decay * getattr(self, name)
        return grads

    def _scatter(self, grads: dict, name: str, ids: np.ndarray, mask: np.ndarray, d_h: np.ndarray) -> None:
        """Push a pooled-gradient back onto the individual token embeddings."""
        counts = np.maximum(mask.sum(axis=1, keepdims=True), 1.0)
        per_token = (d_h / counts)[:, None, :] * mask[:, :, None]   # [B, L, dm]
        accumulated = grads.setdefault(name, np.zeros_like(self.E))
        np.add.at(accumulated, ids, per_token)

    # --- optimisation -----------------------------------------------------

    def step(self, batch: Batch) -> float:
        """One Adam update. Returns the loss *before* the update."""
        grads = self.gradients(batch)
        before = self.loss(batch)

        self._step += 1
        beta1, beta2, eps = self.config.beta1, self.config.beta2, self.config.epsilon
        correction1 = 1 - beta1**self._step
        correction2 = 1 - beta2**self._step
        lr = self.config.learning_rate

        for name in self.PARAMETER_NAMES:
            gradient = grads[name]
            if self.config.gradient_clip:
                norm = np.linalg.norm(gradient)
                if norm > self.config.gradient_clip:
                    gradient = gradient * (self.config.gradient_clip / max(norm, 1e-12))
            first, second = self._adam[name]
            first = beta1 * first + (1 - beta1) * gradient
            second = beta2 * second + (1 - beta2) * (gradient**2)
            self._adam[name] = (first, second)
            # np.sqrt, not math.sqrt: `second` is a whole parameter tensor.
            update = lr * (first / correction1) / (np.sqrt(second / correction2) + eps)
            setattr(self, name, getattr(self, name) - update)
        return before

    def make_batches(self, triples: list[tuple[str, str, str | None]], *, shuffle_seed: int | None = None) -> list[Batch]:
        """Group (query, positive, hard-negative) triples into padded batches."""
        if not triples:
            raise ValueError("cannot build batches from zero triples")
        rows = list(triples)
        rng = np.random.default_rng(self.config.seed if shuffle_seed is None else shuffle_seed)
        order = rng.permutation(len(rows))
        batches: list[Batch] = []
        for start in range(0, len(rows), self.config.batch_size):
            chunk = [rows[i] for i in order[start : start + self.config.batch_size]]
            if len(chunk) < 2:
                # InfoNCE needs at least one in-batch negative to contrast against,
                # so a trailing single-row batch is dropped rather than trained on.
                continue
            queries = [self.vocab.encode(q, max_tokens=self.config.max_tokens) or [self.vocab.pad_id] for q, _, _ in chunk]
            positives = [self.vocab.encode(p, max_tokens=self.config.max_tokens) or [self.vocab.pad_id] for _, p, _ in chunk]
            has_negatives = all(n is not None for _, _, n in chunk)
            q_ids, q_mask = _pad(queries, self.vocab.pad_id)
            p_ids, p_mask = _pad(positives, self.vocab.pad_id)
            n_ids = n_mask = None
            if has_negatives:
                negatives = [self.vocab.encode(n, max_tokens=self.config.max_tokens) or [self.vocab.pad_id] for _, _, n in chunk]
                n_ids, n_mask = _pad(negatives, self.vocab.pad_id)
            batches.append(Batch(q_ids, q_mask, p_ids, p_mask, n_ids, n_mask))
        if not batches:
            raise ValueError(f"{len(rows)} triples cannot form a single batch of at least 2")
        return batches

    def train(self, triples: list[tuple[str, str, str | None]], *, epochs: int | None = None, verbose: bool = False) -> list[TrainingEpoch]:
        """Train on triples. Returns one record per epoch."""
        import time

        total = epochs if epochs is not None else self.config.epochs
        for epoch in range(1, total + 1):
            started = time.perf_counter()
            # A different shuffle each epoch, but reproducible from the seed.
            batches = self.make_batches(triples, shuffle_seed=self.config.seed * 1000 + epoch)
            losses, accuracies = [], []
            for batch in batches:
                losses.append(self.step(batch))
                accuracies.append(self.accuracy(batch))
            record = TrainingEpoch(
                epoch=epoch,
                loss=float(np.mean(losses)) if losses else float("nan"),
                accuracy=float(np.mean(accuracies)) if accuracies else 0.0,
                lr=self.config.learning_rate,
                seconds=round(time.perf_counter() - started, 4),
                batches=len(batches),
            )
            self.history.append(record)
            if verbose:
                print(f"  epoch {epoch:3d}  loss {record.loss:.4f}  in-batch acc {record.accuracy:.3f}  {record.seconds:.2f}s")
        return self.history

    # --- serialisation ----------------------------------------------------

    def state_dict(self) -> dict[str, np.ndarray]:
        return {name: getattr(self, name).copy() for name in self.PARAMETER_NAMES}

    def load_state_dict(self, state: dict[str, np.ndarray]) -> None:
        for name in self.PARAMETER_NAMES:
            incoming = np.asarray(state[name], dtype=np.float64)
            current = getattr(self, name)
            if incoming.shape != current.shape:
                raise ValueError(f"{name}: expected shape {current.shape}, got {incoming.shape}")
            setattr(self, name, incoming)

    def save(self, path) -> dict:
        """Write weights plus everything needed to load and reproduce them."""
        payload = {
            "format": "aetheris-lite-dual-encoder/1",
            "config": self.config.as_dict(),
            "configDigest": self.config.digest(),
            "vocabDigest": self.vocab.digest(),
            "vocabSize": len(self.vocab),
            "parameterCount": self.parameter_count(),
            "parameters": {name: getattr(self, name).tolist() for name in self.PARAMETER_NAMES},
        }
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        payload["sha256"] = self.weights_digest()
        return payload

    @classmethod
    def load(cls, path, vocabulary: Vocabulary) -> "DualEncoder":
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
        if payload.get("format") != "aetheris-lite-dual-encoder/1":
            raise ValueError(f"unsupported checkpoint format: {payload.get('format')!r}")
        if vocabulary.digest() != payload["vocabDigest"]:
            raise ValueError(
                "vocabulary does not match the checkpoint "
                f"({vocabulary.digest()} != {payload['vocabDigest']}); embeddings would be misaligned"
            )
        model = cls(vocabulary, DualEncoderConfig(**payload["config"]))
        model.load_state_dict({name: np.asarray(value, dtype=np.float64) for name, value in payload["parameters"].items()})
        return model

    def weights_digest(self) -> str:
        """Hash of the weights, for the model card and the release gate."""
        digest = hashlib.sha256()
        for name in self.PARAMETER_NAMES:
            array = np.ascontiguousarray(getattr(self, name), dtype=np.float64)
            digest.update(name.encode("utf-8"))
            digest.update(array.tobytes())
        return digest.hexdigest()
