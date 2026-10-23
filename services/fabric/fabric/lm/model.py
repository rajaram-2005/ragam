"""A decoder-only transformer with a hand-written backward pass, in pure NumPy.

Every gradient here is derived by hand and checked against a central finite
difference in `tests/test_lm_model.py`. That test is the reason this file can be
trusted at all: a wrong backward pass does not crash, it trains a model that quietly
learns nothing, and the loss curve alone would not reveal it.

Design choices, each for a stated reason:

* **Pre-LayerNorm with a final LayerNorm.** Post-LN needs a warmup to train at all
  from a cold start; pre-LN does not, and there is no schedule tuning to spare here.
* **Weight tying** between the token embedding and the output projection. At this
  size the embedding is a large fraction of all parameters, and tying is a real,
  free improvement rather than a shortcut.
* **Learned positional embeddings**, not sinusoidal -- at 128 positions there is
  nothing to extrapolate to, and learned ones are one less function to get wrong.
* **tanh-approximated GELU.** NumPy has no `erf`, so the exact form is unavailable
  without SciPy, which this service deliberately does not depend on. This is the
  GPT-2 approximation, not a makeshift substitute.
* **Flat parameter dictionary, not classes per layer.** Finite differencing needs to
  perturb one named array by an index, and a flat dict makes that direct.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, asdict

import numpy as np

GELU_C = math.sqrt(2.0 / math.pi)
GELU_K = 0.044715


# ---------------------------------------------------------------------------
# Primitives, each with the backward pass it is paired with
# ---------------------------------------------------------------------------


def gelu(x: np.ndarray) -> np.ndarray:
    """tanh approximation of GELU, as used by GPT-2."""
    inner = GELU_C * (x + GELU_K * x**3)
    return 0.5 * x * (1.0 + np.tanh(inner))


def gelu_backward(x: np.ndarray, dout: np.ndarray) -> np.ndarray:
    inner = GELU_C * (x + GELU_K * x**3)
    t = np.tanh(inner)
    dinner = GELU_C * (1.0 + 3.0 * GELU_K * x**2)
    return dout * (0.5 * (1.0 + t) + 0.5 * x * (1.0 - t**2) * dinner)


def layernorm(x: np.ndarray, gain: np.ndarray, bias: np.ndarray, eps: float):
    """LayerNorm over the last axis. Returns (output, cache)."""
    mean = x.mean(axis=-1, keepdims=True)
    centered = x - mean
    var = (centered**2).mean(axis=-1, keepdims=True)
    inv = 1.0 / np.sqrt(var + eps)
    xhat = centered * inv
    return gain * xhat + bias, (xhat, inv)


def layernorm_backward(dout: np.ndarray, cache, gain: np.ndarray):
    """Returns (dx, dgain, dbias).

    `gain` is needed here and not in the forward cache because dBias and dX both
    depend on the elementwise product, and re-deriving it from the cache would mean
    storing it twice.
    """
    xhat, inv = cache
    dxhat = dout * gain
    # The standard closed form: subtracting both the mean of dxhat and the projection
    # of dxhat onto xhat removes the components that normalisation discards.
    dx = inv * (dxhat - dxhat.mean(axis=-1, keepdims=True) - xhat * (dxhat * xhat).mean(axis=-1, keepdims=True))
    axes = tuple(range(dout.ndim - 1))
    return dx, (dout * xhat).sum(axis=axes), dout.sum(axis=axes)


def softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    shifted = x - x.max(axis=axis, keepdims=True)
    e = np.exp(shifted)
    return e / e.sum(axis=axis, keepdims=True)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TransformerConfig:
    vocab_size: int
    d_model: int = 128
    n_layers: int = 2
    n_heads: int = 4
    d_ff: int = 512
    seq_len: int = 128
    dropout: float = 0.0  # unused; present so a config that claims it is rejected
    tie_embeddings: bool = True
    init_scale: float = 0.02
    layernorm_eps: float = 1e-5

    # The two differentiators, as parts of the model rather than as wrappers around it.
    #
    # `age_buckets` gives every token a learned slot for how old the evidence behind it is, and
    # `state_classes` gives every sequence a learned slot for the state the user expressed in it.
    # Both are conditioning tables added to the input hidden state, and both are trained by the
    # same backward pass as everything else.
    #
    # The two heads read the final LayerNorm output at the last position: `verdict` decides
    # whether the answer is grounded in a source that is still current, or abstains; `state`
    # predicts the user's expressed state, with a class reserved for "nothing was expressed".
    # They are trained *with* the language objective, in one loss, which is the difference between
    # "the model grounds its answers" and "a script checks the model afterwards".
    #
    # Zero and False by default, so every artifact trained before these parts existed -- including
    # the released Lite model -- still has exactly the parameters it recorded.
    age_buckets: int = 0
    state_classes: int = 0
    verdict_head: bool = False
    state_head: bool = False

    def __post_init__(self) -> None:
        if self.vocab_size < 2:
            raise ValueError(f"vocab_size must be at least 2, got {self.vocab_size}")
        if self.d_model % self.n_heads:
            raise ValueError(
                f"d_model {self.d_model} is not divisible by n_heads {self.n_heads}"
            )
        if self.dropout:
            # Silently ignoring a configured dropout would make a run look
            # regularised when it is not.
            raise ValueError("dropout is not implemented in this NumPy model; set it to 0")
        for name in ("d_model", "n_layers", "n_heads", "d_ff", "seq_len"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive, got {getattr(self, name)}")
        for name in ("age_buckets", "state_classes"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} must not be negative, got {getattr(self, name)}")
        if self.state_head and not self.state_classes:
            raise ValueError(
                "state_head needs state_classes > 0: a head with no classes has nothing to predict"
            )

    @property
    def head_dim(self) -> int:
        return self.d_model // self.n_heads

    @property
    def differentiator_parameters(self) -> int:
        """Parameters the two differentiators add, or 0 for a config without them."""
        d = self.d_model
        total = 0
        if self.age_buckets:
            total += self.age_buckets * d          # how old the evidence is, per token
        if self.state_classes:
            total += self.state_classes * d        # what the user expressed, per sequence
        if self.verdict_head:
            total += 2 * d + 2                     # grounded or abstain
        if self.state_head:
            total += self.state_classes * d + self.state_classes
        return total

    def parameter_count(self) -> int:
        d, ff, v, L = self.d_model, self.d_ff, self.vocab_size, self.n_layers
        emb = v * d
        per_layer = 4 * d * d + 2 * d * ff + 4 * d  # attn + mlp + two LayerNorms
        pos = self.seq_len * d
        final_ln = 2 * d
        head = 0 if self.tie_embeddings else v * d
        return emb + pos + L * per_layer + final_ln + head + self.differentiator_parameters

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def digest(self) -> str:
        payload = json.dumps(self.to_dict(), sort_keys=True)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


PARAMETER_ORDER = (
    "emb", "pos",
    "ln1_gain", "ln1_bias", "wq", "wk", "wv", "wo", "ln2_gain", "ln2_bias", "w1", "w2",
    "lnf_gain", "lnf_bias", "head",
)


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class TransformerLM:
    """A small decoder-only transformer. Trainable by `train.py`, nothing more."""

    def __init__(self, config: TransformerConfig, *, seed: int = 0, dtype=np.float32):
        self.config = config
        self.dtype = dtype
        self.seed = seed
        self.params: dict[str, np.ndarray] = {}
        self._rng = np.random.default_rng(seed)
        self._init_parameters()

    # -- construction ------------------------------------------------------

    def _normal(self, shape, scale=None) -> np.ndarray:
        s = self.config.init_scale if scale is None else scale
        return (self._rng.standard_normal(shape) * s).astype(self.dtype)

    def _init_parameters(self) -> None:
        c = self.config
        d, ff, v, L = c.d_model, c.d_ff, c.vocab_size, c.n_layers
        p = self.params
        p["emb"] = self._normal((v, d))
        p["pos"] = self._normal((c.seq_len, d))
        for layer in range(L):
            # Residual outputs are scaled down by 1/sqrt(2L): without this the
            # residual stream grows with depth and the final LayerNorm sees an
            # input whose scale depends on layer count.
            res = c.init_scale / math.sqrt(2 * L)
            p[f"L{layer}.ln1_gain"] = np.ones(d, self.dtype)
            p[f"L{layer}.ln1_bias"] = np.zeros(d, self.dtype)
            p[f"L{layer}.wq"] = self._normal((d, d), res)
            p[f"L{layer}.wk"] = self._normal((d, d), res)
            p[f"L{layer}.wv"] = self._normal((d, d), res)
            p[f"L{layer}.wo"] = self._normal((d, d), res)
            p[f"L{layer}.ln2_gain"] = np.ones(d, self.dtype)
            p[f"L{layer}.ln2_bias"] = np.zeros(d, self.dtype)
            p[f"L{layer}.w1"] = self._normal((d, ff), c.init_scale)
            p[f"L{layer}.w2"] = self._normal((ff, d), res)
        p["lnf_gain"] = np.ones(d, self.dtype)
        p["lnf_bias"] = np.zeros(d, self.dtype)
        if not c.tie_embeddings:
            p["head"] = self._normal((v, d))
        # The differentiator parts. They are created only when the config asks for them, so a
        # config without them produces a parameter dictionary with exactly the same keys as the
        # one the released Lite artifact recorded.
        if c.age_buckets:
            p["age_emb"] = self._normal((c.age_buckets, d))
        if c.state_classes:
            p["state_emb"] = self._normal((c.state_classes, d))
        if c.verdict_head:
            p["verdict_w"] = self._normal((d, 2), res)
            p["verdict_b"] = np.zeros(2, self.dtype)
        if c.state_head:
            p["state_head_w"] = self._normal((d, c.state_classes), res)
            p["state_head_b"] = np.zeros(c.state_classes, self.dtype)

    def zero_grads(self) -> dict[str, np.ndarray]:
        return {name: np.zeros_like(array) for name, array in self.params.items()}

    @property
    def parameter_count(self) -> int:
        return sum(a.size for a in self.params.values())

    # -- forward -----------------------------------------------------------

    def forward(self, inputs: np.ndarray, *, cache: bool = False, ages=None, states=None):
        """Returns either logits or (logits, cache) for the backward pass.

        `ages` (B, T) and `states` (B,) are the differentiator inputs, and they are required
        exactly when the config has the parts that consume them: a model with `age_buckets` that
        was handed no ages would otherwise silently train as if every source were equally fresh.
        """
        c = self.config
        B, T = inputs.shape
        if T > c.seq_len:
            raise ValueError(f"sequence length {T} exceeds the configured {c.seq_len}")

        if c.age_buckets:
            if ages is None:
                raise ValueError(f"this model has age_buckets={c.age_buckets}, so forward needs `ages`")
            ages = np.asarray(ages, dtype=np.int64)
            if ages.shape != inputs.shape:
                raise ValueError(f"ages must have the same shape as inputs, got {ages.shape} and {inputs.shape}")
            if ages.size and (ages.min() < 0 or ages.max() >= c.age_buckets):
                raise ValueError(f"ages must be bucket ids in [0, {c.age_buckets})")
        if c.state_classes:
            if states is None:
                raise ValueError(f"this model has state_classes={c.state_classes}, so forward needs `states`")
            states = np.asarray(states, dtype=np.int64)
            if states.shape != (B,):
                raise ValueError(f"states must have shape ({B},), got {states.shape}")
            if states.size and (states.min() < 0 or states.max() >= c.state_classes):
                raise ValueError(f"states must be class ids in [0, {c.state_classes})")

        emb = self.params["emb"]
        h = emb[inputs] + self.params["pos"][:T]
        # How old the evidence behind each token is, and what the user expressed in the turn.
        # Added to the input hidden state, so every layer sees them; the backward pass for both is
        # a scatter-add over the rows that were selected.
        if c.age_buckets:
            h = h + self.params["age_emb"][ages]
        if c.state_classes:
            h = h + self.params["state_emb"][states][:, None, :]
        saved = []
        mask = np.triu(np.full((T, T), -1e9, dtype=self.dtype), 1)

        for layer in range(c.n_layers):
            pre = self.params[f"L{layer}.ln1_gain"]
            pib = self.params[f"L{layer}.ln1_bias"]
            a, ln1_cache = layernorm(h, pre, pib, c.layernorm_eps)
            q = a @ self.params[f"L{layer}.wq"]
            k = a @ self.params[f"L{layer}.wk"]
            v = a @ self.params[f"L{layer}.wv"]
            qh = q.reshape(B, T, c.n_heads, c.head_dim).transpose(0, 2, 1, 3)
            kh = k.reshape(B, T, c.n_heads, c.head_dim).transpose(0, 2, 1, 3)
            vh = v.reshape(B, T, c.n_heads, c.head_dim).transpose(0, 2, 1, 3)
            scores = qh @ kh.transpose(0, 1, 3, 2) / math.sqrt(c.head_dim) + mask
            att = softmax(scores, axis=-1)
            y = (att @ vh).transpose(0, 2, 1, 3).reshape(B, T, c.d_model)
            o = y @ self.params[f"L{layer}.wo"]
            h = h + o

            ln2_gain = self.params[f"L{layer}.ln2_gain"]
            ln2_bias = self.params[f"L{layer}.ln2_bias"]
            b, ln2_cache = layernorm(h, ln2_gain, ln2_bias, c.layernorm_eps)
            z = b @ self.params[f"L{layer}.w1"]
            g = gelu(z)
            u = g @ self.params[f"L{layer}.w2"]
            h = h + u

            if cache:
                saved.append({
                    "a": a, "ln1": ln1_cache, "q": qh, "k": kh, "v": vh, "att": att,
                    "yin": y, "b": b, "ln2": ln2_cache, "z": z, "h_out": h,
                })

        hidden = h
        hf, lnf_cache = layernorm(hidden, self.params["lnf_gain"], self.params["lnf_bias"], c.layernorm_eps)
        head = self.params["emb"] if c.tie_embeddings else self.params["head"]
        logits = hf @ head.T
        if not cache:
            return logits
        return logits, {
            "layers": saved, "hf": hf, "lnf": lnf_cache, "inputs": inputs, "T": T, "B": B,
            "ages": ages, "states": states,
        }

    def task_logits(self, hf: np.ndarray) -> dict:
        """The differentiator heads' logits, read from the final LayerNorm output.

        The last position is the one that has seen the whole sequence, and it is the position the
        heads are trained on. An empty dictionary means the config has no heads.
        """
        out = {}
        last = hf[:, -1, :]
        if "verdict_w" in self.params:
            out["verdict"] = last @ self.params["verdict_w"] + self.params["verdict_b"]
        if "state_head_w" in self.params:
            out["state"] = last @ self.params["state_head_w"] + self.params["state_head_b"]
        return out

    # -- loss --------------------------------------------------------------

    def loss(self, inputs: np.ndarray, targets: np.ndarray, *, ages=None, states=None,
             verdict_targets=None, verdict_weight: float = 1.0,
             state_targets=None, state_weight: float = 1.0) -> float:
        """Mean cross-entropy in nats per token, plus the differentiator heads when targeted.

        The heads are part of the same number on purpose: a model whose language loss ignores them
        would be a language model with two attachments, not a model that grounds and abstains.
        """
        if verdict_targets is None and state_targets is None:
            logits = self.forward(inputs, ages=ages, states=states)
            return float(self._cross_entropy(logits, targets)[0])
        logits, cache = self.forward(inputs, cache=True, ages=ages, states=states)
        total = float(self._cross_entropy(logits, targets)[0])
        heads = self.task_logits(cache["hf"])
        if "verdict" in heads and verdict_targets is not None:
            total += verdict_weight * self._row_cross_entropy(heads["verdict"], verdict_targets)[0]
        if "state" in heads and state_targets is not None:
            total += state_weight * self._row_cross_entropy(heads["state"], state_targets)[0]
        return float(total)

    @staticmethod
    def _row_cross_entropy(logits: np.ndarray, targets: np.ndarray):
        """Cross-entropy over whole rows (one label per sequence). Returns (loss, dlogits)."""
        rows = np.arange(logits.shape[0])
        labels = np.asarray(targets, dtype=np.int64).reshape(-1)
        shifted = logits - logits.max(axis=-1, keepdims=True)
        e = np.exp(shifted)
        probs = e / e.sum(axis=-1, keepdims=True)
        chosen = probs[rows, labels]
        loss = float(-np.log(np.maximum(chosen, 1e-12)).mean())
        grad = probs
        grad[rows, labels] -= 1.0
        grad /= logits.shape[0]
        return loss, grad

    @staticmethod
    def _cross_entropy(logits: np.ndarray, targets: np.ndarray):
        B, T, V = logits.shape
        flat = logits.reshape(-1, V)
        flat = flat - flat.max(axis=-1, keepdims=True)
        e = np.exp(flat)
        probs = e / e.sum(axis=-1, keepdims=True)
        rows = np.arange(B * T)
        chosen = probs[rows, targets.reshape(-1).astype(np.int64)]
        loss = float(-np.log(np.maximum(chosen, 1e-12)).mean())
        grad = probs
        grad[rows, targets.reshape(-1).astype(np.int64)] -= 1.0
        grad /= B * T
        return loss, grad.reshape(B, T, V)

    # -- backward ----------------------------------------------------------

    def loss_and_grads(self, inputs: np.ndarray, targets: np.ndarray, *, ages=None, states=None,
                       verdict_targets=None, verdict_weight: float = 1.0,
                       state_targets=None, state_weight: float = 1.0):
        """Returns (loss_in_nats, grads) for next-token prediction plus the targeted heads.

        The head losses enter the same gradient as the language loss: their weight matrices get
        their own gradient, and the gradient they send back into the final hidden state is added
        at the last position, where it flows through every layer that produced it.
        """
        logits, cache = self.forward(inputs, cache=True, ages=ages, states=states)
        loss, dlogits = self._cross_entropy(logits, targets)
        head_gradient = np.zeros((cache["B"], self.config.d_model), dtype=self.dtype)
        head_grads = {}
        heads = self.task_logits(cache["hf"])
        last = cache["hf"][:, -1, :]
        if "verdict" in heads and verdict_targets is not None:
            head_loss, dlogit = self._row_cross_entropy(heads["verdict"], verdict_targets)
            loss += verdict_weight * head_loss
            dlogit = dlogit * verdict_weight
            head_grads["verdict_w"] = last.T @ dlogit
            head_grads["verdict_b"] = dlogit.sum(axis=0)
            head_gradient += dlogit @ self.params["verdict_w"].T
        if "state" in heads and state_targets is not None:
            head_loss, dlogit = self._row_cross_entropy(heads["state"], state_targets)
            loss += state_weight * head_loss
            dlogit = dlogit * state_weight
            head_grads["state_head_w"] = last.T @ dlogit
            head_grads["state_head_b"] = dlogit.sum(axis=0)
            head_gradient += dlogit @ self.params["state_head_w"].T
        grads = self.backward_from_dlogits(dlogits, cache, head_gradient=head_gradient)
        for name, value in head_grads.items():
            grads[name] += value
        return float(loss), grads

    def backward_from_dlogits(self, dlogits: np.ndarray, cache: dict, *, head_gradient=None):
        """Backpropagate an arbitrary gradient on the logits.

        Split out so knowledge distillation can supply its own gradient -- the
        weighted sum of a cross-entropy term and a temperature-scaled KL term --
        without duplicating any of the backward pass below. Everything after this
        point depends only on `dlogits` and the forward cache, so both objectives
        share one verified implementation rather than two that could drift apart.
        """
        c = self.config
        inputs, T, B = cache["inputs"], cache["T"], cache["B"]

        grads = self.zero_grads()
        head = self.params["emb"] if c.tie_embeddings else self.params["head"]
        hf = cache["hf"]
        d_hf = dlogits @ head
        grads["head" if not c.tie_embeddings else "emb"] += dlogits.reshape(-1, c.vocab_size).T @ hf.reshape(-1, c.d_model)
        if head_gradient is not None:
            # The heads read the last position, so that is where their gradient enters.
            d_hf[:, -1, :] = d_hf[:, -1, :] + head_gradient

        d_hidden, dlnf_gain, dlnf_bias = layernorm_backward(d_hf, cache["lnf"], self.params["lnf_gain"])
        grads["lnf_gain"] += dlnf_gain
        grads["lnf_bias"] += dlnf_bias

        hd = c.head_dim
        inv_scale = 1.0 / math.sqrt(hd)

        for layer in reversed(range(c.n_layers)):
            s = cache["layers"][layer]
            prefix = f"L{layer}."

            # residual branch 2: h = h + gelu(b @ w1) @ w2
            d_g = d_hidden @ self.params[prefix + "w2"].T
            # w2 maps the GELU output back to d_model, so its gradient pairs the
            # activation with the incoming gradient -- not with z.
            grads[prefix + "w2"] += gelu(s["z"]).reshape(-1, c.d_ff).T @ d_hidden.reshape(-1, c.d_model)
            d_z = gelu_backward(s["z"], d_g)
            grads[prefix + "w1"] += s["b"].reshape(-1, c.d_model).T @ d_z.reshape(-1, c.d_ff)
            d_b = d_z @ self.params[prefix + "w1"].T
            d_ln2_carry, d_ln2_gain, d_ln2_bias = layernorm_backward(d_b, s["ln2"], self.params[prefix + "ln2_gain"])
            grads[prefix + "ln2_gain"] += d_ln2_gain
            grads[prefix + "ln2_bias"] += d_ln2_bias
            d_hidden = d_hidden + d_ln2_carry

            # residual branch 1: h = h + attn(ln1(h)) @ wo
            d_y = d_hidden @ self.params[prefix + "wo"].T
            grads[prefix + "wo"] += s["yin"].reshape(-1, c.d_model).T @ d_hidden.reshape(-1, c.d_model)
            d_yh = d_y.reshape(B, T, c.n_heads, hd).transpose(0, 2, 1, 3)

            d_att = d_yh @ s["v"].transpose(0, 1, 3, 2)
            d_vh = s["att"].transpose(0, 1, 3, 2) @ d_yh
            # softmax backward: ds = att * (datt - sum(datt * att))
            d_scores = s["att"] * (d_att - (d_att * s["att"]).sum(axis=-1, keepdims=True))
            d_qh = (d_scores @ s["k"]) * inv_scale
            d_kh = (d_scores.transpose(0, 1, 3, 2) @ s["q"]) * inv_scale

            def unhead(x):
                return x.transpose(0, 2, 1, 3).reshape(B, T, c.d_model)

            d_q, d_k, d_v = unhead(d_qh), unhead(d_kh), unhead(d_vh)
            a = s["a"]
            grads[prefix + "wq"] += a.reshape(-1, c.d_model).T @ d_q.reshape(-1, c.d_model)
            grads[prefix + "wk"] += a.reshape(-1, c.d_model).T @ d_k.reshape(-1, c.d_model)
            grads[prefix + "wv"] += a.reshape(-1, c.d_model).T @ d_v.reshape(-1, c.d_model)
            d_a = d_q @ self.params[prefix + "wq"].T
            d_a += d_k @ self.params[prefix + "wk"].T
            d_a += d_v @ self.params[prefix + "wv"].T
            d_ln1_carry, d_ln1_gain, d_ln1_bias = layernorm_backward(d_a, s["ln1"], self.params[prefix + "ln1_gain"])
            grads[prefix + "ln1_gain"] += d_ln1_gain
            grads[prefix + "ln1_bias"] += d_ln1_bias
            d_hidden = d_hidden + d_ln1_carry

        # input embedding and positions
        rows = inputs.reshape(-1).astype(np.int64)
        d_flat = d_hidden.reshape(-1, c.d_model)
        np.add.at(grads["emb"], rows, d_flat)
        grads["pos"][:T] += d_hidden.sum(axis=0)

        # The differentiator inputs, each accumulated into the row it selected. `d_flat` is
        # row-major over (B, T), which is the order `ages.reshape(-1)` is in; the state row was
        # added to every position of its sequence, so its gradient is the sum over those positions.
        ages, states = cache.get("ages"), cache.get("states")
        if ages is not None and "age_emb" in grads:
            flat_ages = ages.reshape(-1).astype(np.int64)
            np.add.at(grads["age_emb"], flat_ages, d_flat)
        if states is not None and "state_emb" in grads:
            np.add.at(grads["state_emb"], states.astype(np.int64), d_hidden.sum(axis=1))

        return grads

    # -- persistence -------------------------------------------------------

    def save(self, path) -> str:
        """Write parameters to an .npz and return the artifact digest."""
        np.savez(path, **self.params)
        return artifact_digest(path)

    @classmethod
    def load(cls, path, config: TransformerConfig):
        with np.load(path) as probe:
            # Infer the dtype from the checkpoint instead of assuming float32. A
            # float64 checkpoint reloaded as float32 changes the weights, and the
            # digest -- which exists to detect exactly that -- would flag a
            # round-trip that is supposed to be lossless.
            first = next(iter(probe.files))
            dtype = probe[first].dtype
        model = cls(config, seed=0, dtype=dtype)
        with np.load(path) as data:
            for name in model.params:
                if name not in data:
                    raise KeyError(f"checkpoint is missing parameter '{name}'")
                model.params[name] = data[name].astype(model.dtype)
            extra = set(data.files) - set(model.params)
            if extra:
                # A checkpoint with parameters the config does not describe is not
                # safe to load: it was written for a different architecture.
                raise KeyError(f"checkpoint has unexpected parameters: {sorted(extra)}")
        return model


def artifact_digest(path) -> str:
    """SHA-256 of a file on disk."""
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def weights_digest(params: dict[str, np.ndarray]) -> str:
    """Order-independent-but-stable digest of in-memory parameters.

    Names and shapes are hashed alongside the bytes, so swapping two arrays or
    reshaping one cannot leave the digest unchanged.
    """
    h = hashlib.sha256()
    for name in sorted(params):
        array = np.ascontiguousarray(params[name])
        h.update(name.encode("utf-8"))
        h.update(str(array.shape).encode("utf-8"))
        h.update(str(array.dtype).encode("utf-8"))
        h.update(array.tobytes())
    return h.hexdigest()
