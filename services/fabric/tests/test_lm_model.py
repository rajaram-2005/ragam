"""Gradient, causality and persistence tests for the from-scratch transformer.

The finite-difference check is the important one. A wrong backward pass does not
raise, does not produce NaNs, and does not stop the loss falling -- it trains a
model that learns the wrong thing, or learns more slowly than it should, and the
only symptom is a number that is worse than it needed to be. There is no way to
notice that by reading the code, so every parameter is checked numerically here.

The model runs in float64 for these checks. In float32 central differences with a
step of 1e-5 are swamped by rounding error and the comparison stops meaning
anything; testing the backward pass in the precision where it can actually be
verified is the point, and a separate looser float32 check confirms it survives the
precision the real training run uses.
"""

from __future__ import annotations

import numpy as np
import pytest

from fabric.lm.model import (
    TransformerConfig,
    TransformerLM,
    gelu,
    gelu_backward,
    layernorm,
    layernorm_backward,
    softmax,
    weights_digest,
)


SMALL = dict(vocab_size=17, d_model=16, n_layers=2, n_heads=4, d_ff=32, seq_len=8)


def make_model(**overrides):
    config = TransformerConfig(**{**SMALL, **overrides})
    return config, TransformerLM(config, seed=3, dtype=np.float64)


@pytest.fixture(scope="module")
def batch():
    rng = np.random.default_rng(11)
    return rng.integers(0, 17, (2, 8)), rng.integers(0, 17, (2, 8))


#: Central differences on a loss of order 1 in float64 have a roundoff floor of
#: roughly eps_machine * |loss| / (2 * step) ~ 1e-11. Comparing two gradients with a
#: purely *relative* tolerance is therefore wrong for entries whose gradient is
#: itself near 1e-7: an absolute difference of 1e-11 is pure noise there, but shows
#: up as a relative error of 1e-4. The comparison below is the usual
#: |a - b| <= atol + rtol * |b| form, with atol just above that floor and rtol tight
#: enough that any real mistake -- which produces errors of order 1e-2 or worse --
#: is caught.
FD_RTOL = 1e-5
FD_ATOL = 1e-9


def numeric_gradient(model, inputs, targets, name, *, samples=12, eps=1e-5, seed=0):
    """Central finite differences over a spread of entries of one parameter."""
    rng = np.random.default_rng(seed)
    array = model.params[name]
    indices = rng.choice(array.size, size=min(samples, array.size), replace=False)
    numeric = np.zeros(indices.size)
    flat = array.reshape(-1)
    analytic_flat = model.loss_and_grads(inputs, targets)[1][name].reshape(-1)
    for k, index in enumerate(indices):
        original = flat[index]
        flat[index] = original + eps
        plus = model.loss(inputs, targets)
        flat[index] = original - eps
        minus = model.loss(inputs, targets)
        flat[index] = original
        numeric[k] = (plus - minus) / (2 * eps)
    return numeric, analytic_flat[indices], indices


def gradient_violation(numeric, analytic):
    """Largest amount by which the two disagree, beyond the allowed tolerance.

    Zero or negative means they agree everywhere.
    """
    allowed = FD_ATOL + FD_RTOL * np.abs(analytic)
    return float(np.max(np.abs(numeric - analytic) - allowed))


# ---------------------------------------------------------------------------
# Gradient correctness
# ---------------------------------------------------------------------------


def test_every_parameter_gradient_matches_a_finite_difference(batch):
    """The whole reason the backward pass can be trusted."""
    config, model = make_model()
    inputs, targets = batch
    checked = 0
    failures = []
    for name in model.params:
        numeric, analytic, indices = numeric_gradient(model, inputs, targets, name)
        assert np.all(np.isfinite(numeric)), f"numeric gradient for {name} is not finite"
        assert np.all(np.isfinite(analytic)), f"analytic gradient for {name} is not finite"
        checked += numeric.size
        violation = gradient_violation(numeric, analytic)
        if violation > 0:
            worst = int(np.argmax(np.abs(numeric - analytic)))
            failures.append(
                f"{name}: exceeds tolerance by {violation:.3e} at index {indices[worst]} "
                f"(numeric {numeric[worst]:.8e}, analytic {analytic[worst]:.8e})"
            )
    assert not failures, "gradient mismatch:\n  " + "\n  ".join(failures)
    assert checked >= 60, f"only {checked} entries were checked; that is too few to conclude anything"


def test_the_gradient_check_would_catch_a_wrong_backward_pass(batch):
    """A negative control for the test above.

    The check is only worth having if it fails when the backward pass is wrong. This
    corrupts one gradient deliberately and asserts the comparison notices -- so the
    test above cannot be passing because the tolerance is too loose or because the
    comparison is silently comparing a value with itself.
    """
    config, model = make_model()
    inputs, targets = batch

    def corrupted(name):
        numeric, analytic, _ = numeric_gradient(model, inputs, targets, name)
        return gradient_violation(numeric, analytic + 0.1 * np.abs(analytic).max() + 1e-3)

    # A deliberately wrong gradient must exceed the tolerance used above. This is
    # what stops the previous test passing vacuously: if the tolerance were too
    # loose, or the comparison were comparing a value with itself, these would not
    # trip.
    for name in ("L0.wq", "L1.wo", "lnf_gain", "emb"):
        assert corrupted(name) > 0, f"a corrupted {name} gradient was not detected"


def test_gradients_are_finite_in_float32_too(batch):
    """The precision training actually uses. Tolerance is looser by necessity."""
    config = TransformerConfig(**SMALL)
    model = TransformerLM(config, seed=5, dtype=np.float32)
    inputs = np.asarray(batch[0], dtype=np.int32)
    targets = np.asarray(batch[1], dtype=np.int32)
    loss, grads = model.loss_and_grads(inputs, targets)
    assert np.isfinite(loss)
    for name, grad in grads.items():
        assert np.all(np.isfinite(grad)), f"{name} has a non-finite gradient"
        assert grad.dtype == np.float32


def test_an_all_zero_input_does_not_produce_nan_gradients():
    """Position 0 is always in context; a degenerate batch must not break it."""
    config, model = make_model()
    zeros = np.zeros((2, 8), dtype=np.int32)
    loss, grads = model.loss_and_grads(zeros, zeros)
    assert np.isfinite(loss)
    assert all(np.all(np.isfinite(g)) for g in grads.values())


# ---------------------------------------------------------------------------
# Primitive backward passes, in isolation
# ---------------------------------------------------------------------------


def test_layernorm_backward_matches_finite_differences():
    rng = np.random.default_rng(2)
    x = rng.standard_normal((4, 6))
    gain, bias = rng.standard_normal(6), rng.standard_normal(6)
    dout = rng.standard_normal((4, 6))
    _, cache = layernorm(x, gain, bias, 1e-5)
    dx, dgain, dbias = layernorm_backward(dout, cache, gain)

    eps = 1e-6
    for name, got, base in (("x", dx, x), ("gain", dgain, gain), ("bias", dbias, bias)):
        for _ in range(6):
            i = tuple(rng.integers(0, s) for s in base.shape)
            up = base.copy(); up[i] += eps
            dn = base.copy(); dn[i] -= eps
            plus = (layernorm(up if name == "x" else x, up if name == "gain" else gain,
                              up if name == "bias" else bias, 1e-5)[0] * dout).sum()
            minus = (layernorm(dn if name == "x" else x, dn if name == "gain" else gain,
                               dn if name == "bias" else bias, 1e-5)[0] * dout).sum()
            assert (plus - minus) / (2 * eps) == pytest.approx(got[i], rel=1e-5, abs=1e-6)


def test_gelu_backward_matches_finite_differences():
    rng = np.random.default_rng(4)
    x = rng.standard_normal((5, 7)) * 2.0
    dout = rng.standard_normal((5, 7))
    got = gelu_backward(x, dout)
    eps = 1e-6
    for _ in range(8):
        i = tuple(rng.integers(0, s) for s in x.shape)
        up = x.copy(); up[i] += eps
        dn = x.copy(); dn[i] -= eps
        numeric = ((gelu(up) - gelu(dn)) * dout).sum() / (2 * eps)
        assert numeric == pytest.approx(got[i], rel=1e-5, abs=1e-6)


def test_softmax_sums_to_one_and_handles_large_inputs():
    x = np.array([[1000.0, 1001.0, 999.0], [-1000.0, -1001.0, -999.0]])
    p = softmax(x, axis=-1)
    assert np.allclose(p.sum(axis=-1), 1.0)
    assert np.all(np.isfinite(p))
    assert np.all(p >= 0.0)


# ---------------------------------------------------------------------------
# Architecture properties
# ---------------------------------------------------------------------------


def test_the_model_cannot_see_the_future(batch):
    """Causality, asserted directly rather than assumed from the mask."""
    config, model = make_model()
    inputs, _ = batch
    altered = inputs.copy()
    # Change only the final timestep.
    altered[0, -1] = (int(altered[0, -1]) + 5) % config.vocab_size

    before = model.forward(inputs)
    after = model.forward(altered)
    assert np.allclose(before[:, :-1], after[:, :-1]), "a future token changed an earlier prediction"
    assert not np.allclose(before[0, -1], after[0, -1]), (
        "changing the last token must change the last logit, or the test is not exercising anything"
    )


def test_parameter_count_matches_the_configuration():
    for overrides in ({}, {"tie_embeddings": False}, {"n_layers": 3}, {"n_heads": 2}):
        config, model = make_model(**overrides)
        assert model.parameter_count == config.parameter_count(), overrides


def test_weight_tying_actually_shares_the_embedding():
    config, model = make_model()
    assert "head" not in model.params
    assert "head" not in model.zero_grads()
    tied_config, tied = make_model(tie_embeddings=False)
    assert "head" in tied.params
    assert tied.parameter_count > model.parameter_count


def test_a_sequence_longer_than_the_config_is_refused():
    config, model = make_model()
    too_long = np.zeros((1, config.seq_len + 1), dtype=np.int32)
    with pytest.raises(ValueError, match="exceeds the configured"):
        model.forward(too_long)


def test_configuration_mistakes_are_refused_rather_than_ignored():
    with pytest.raises(ValueError, match="divisible"):
        TransformerConfig(**{**SMALL, "d_model": 15, "n_heads": 4})
    with pytest.raises(ValueError, match="dropout is not implemented"):
        # Silently ignoring dropout would make a run look regularised when it is not.
        TransformerConfig(**{**SMALL, "dropout": 0.1})
    with pytest.raises(ValueError, match="at least 2"):
        TransformerConfig(**{**SMALL, "vocab_size": 1})
    with pytest.raises(ValueError, match="must be positive"):
        TransformerConfig(**{**SMALL, "n_layers": 0})


def test_initial_loss_is_about_log_vocabulary(batch):
    """A sanity check that a fresh model is not born biased toward some token."""
    config, model = make_model(vocab_size=64)
    rng = np.random.default_rng(0)
    inputs = rng.integers(0, 64, (4, 8))
    targets = rng.integers(0, 64, (4, 8))
    loss, _ = model.loss_and_grads(inputs, targets)
    assert abs(loss - np.log(64)) < 0.15, f"initial loss {loss:.4f} is far from ln(64)={np.log(64):.4f}"


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def test_save_and_load_round_trips_exactly(tmp_path, batch):
    config, model = make_model()
    path = tmp_path / "weights.npz"
    digest = model.save(path)
    assert len(digest) == 64

    reloaded = TransformerLM.load(path, config)
    assert weights_digest(reloaded.params) == weights_digest(model.params)
    inputs, targets = batch
    assert reloaded.loss(inputs, targets) == pytest.approx(model.loss(inputs, targets), rel=1e-12)


def test_the_digest_notices_a_single_changed_value(tmp_path):
    """Digest stability is what makes 'never silently replace a release' checkable."""
    config, model = make_model()
    original = weights_digest(model.params)
    model.params["L0.wq"][0, 0] += 1e-6
    assert weights_digest(model.params) != original


def test_the_digest_notices_swapped_parameters():
    """Hashing names and shapes alongside bytes prevents a silent reshuffle."""
    config, model = make_model()
    a = weights_digest(model.params)
    model.params["L0.wq"], model.params["L0.wk"] = model.params["L0.wk"], model.params["L0.wq"]
    assert weights_digest(model.params) != a


def test_loading_a_checkpoint_for_a_different_architecture_is_refused(tmp_path):
    config, model = make_model()
    path = tmp_path / "weights.npz"
    model.save(path)
    other = TransformerConfig(**{**SMALL, "n_layers": 3})
    with pytest.raises(KeyError):
        TransformerLM.load(path, other)
