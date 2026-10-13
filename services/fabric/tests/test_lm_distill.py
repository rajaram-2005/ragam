"""Logit distillation: the objective, its gradient, and the baseline equivalence.

The gradient is checked against a central finite difference here for the same reason
the base model's is: a wrong factor on the temperature term does not crash and does
not produce NaN. It silently reweights the two halves of the objective, and the only
symptom is a student that is worse than it should have been.

The other property worth testing is that `alpha = 1.0` reproduces plain cross-entropy
*exactly*. The experiment compares a baseline against a distilled run, and if the two
arms differed in anything but the distillation setting, the comparison would be
measuring the difference in code rather than the difference in method.
"""

from __future__ import annotations

import numpy as np
import pytest

from fabric.lm.distill import (
    DistillConfig,
    distillation_loss_and_grads,
    kl_divergence,
    softmax_temperature,
    teacher_identity,
)
from fabric.lm.model import TransformerConfig, TransformerLM, weights_digest


SMALL = dict(vocab_size=17, d_model=16, n_layers=2, n_heads=4, d_ff=32, seq_len=8)


def pair(**overrides):
    config = TransformerConfig(**{**SMALL, **overrides})
    return TransformerLM(config, seed=1, dtype=np.float64), TransformerLM(config, seed=2, dtype=np.float64)


@pytest.fixture
def batch():
    rng = np.random.default_rng(5)
    return rng.integers(0, 17, (2, 8)), rng.integers(0, 17, (2, 8))


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def test_temperature_one_is_plain_softmax():
    rng = np.random.default_rng(0)
    logits = rng.standard_normal((3, 5))
    got = softmax_temperature(logits, 1.0)
    shifted = logits - logits.max(axis=-1, keepdims=True)
    expected = np.exp(shifted) / np.exp(shifted).sum(axis=-1, keepdims=True)
    assert np.allclose(got, expected)


def test_higher_temperature_makes_the_distribution_softer():
    logits = np.array([[3.0, 1.0, 0.0]])
    cold = softmax_temperature(logits, 0.5)
    warm = softmax_temperature(logits, 5.0)
    assert cold.max() > warm.max(), "a lower temperature should sharpen"
    # Entropy is the measure of softness.
    assert -(warm * np.log(warm)).sum() > -(cold * np.log(cold)).sum()


def test_softmax_is_stable_for_large_and_small_logits():
    for scale in (1e3, -1e3):
        p = softmax_temperature(np.array([[scale, scale - 1, scale + 1]]), 2.0)
        assert np.all(np.isfinite(p))
        assert p.sum() == pytest.approx(1.0)


def test_an_invalid_temperature_is_refused():
    with pytest.raises(ValueError, match="positive"):
        softmax_temperature(np.zeros((1, 2)), 0.0)
    with pytest.raises(ValueError, match="positive"):
        kl_divergence(np.zeros((1, 2)), np.zeros((1, 2)), -1.0)


def test_kl_is_zero_for_identical_distributions_and_positive_otherwise():
    logits = np.random.default_rng(3).standard_normal((4, 6))
    assert kl_divergence(logits, logits, 2.0) == pytest.approx(0.0, abs=1e-12)
    other = np.random.default_rng(4).standard_normal((4, 6))
    assert kl_divergence(logits, other, 2.0) > 0


def test_kl_is_asymmetric_so_the_argument_order_matters():
    """Mean KL is not a distance: the two directions differ.

    The inputs must be genuinely asymmetric. A first version of this test used
    mirror-image distributions -- [2,0,0] against [0,2,0] -- whose KLs are equal by
    symmetry, so it was testing nothing.
    """
    peaked = np.array([[5.0, 0.0, 0.0]])
    flat = np.array([[0.0, 0.0, 0.0]])
    # The signature is (student, teacher) and the value is KL(teacher || student), so
    # the arguments read backwards from the direction being measured. Named locals
    # rather than positional literals, because getting this wrong is invisible.
    student_peaked = kl_divergence(peaked, flat, 1.0)   # KL(flat teacher || peaked student)
    student_flat = kl_divergence(flat, peaked, 1.0)     # KL(peaked teacher || flat student)
    assert student_peaked != pytest.approx(student_flat)
    # Covering a flat teacher with a peaked student puts no mass where the teacher has
    # mass, so it is the more expensive direction.
    assert student_peaked > student_flat


def test_mismatched_shapes_are_refused():
    with pytest.raises(ValueError, match="same shape"):
        kl_divergence(np.zeros((1, 5)), np.zeros((1, 6)), 1.0)


# ---------------------------------------------------------------------------
# The combined objective
# ---------------------------------------------------------------------------


def test_alpha_one_is_exactly_plain_cross_entropy(batch):
    """The baseline arm must be the ordinary objective, not an approximation of it."""
    student, teacher = pair()
    inputs, targets = batch
    loss, grads = distillation_loss_and_grads(student, teacher, inputs, targets, alpha=1.0)
    # Compare against an independent construction of the same objective.
    logits, cache = student.forward(inputs, cache=True)
    expected_loss, dlogits = student._cross_entropy(logits, targets)
    expected = student.backward_from_dlogits(dlogits, cache)

    assert loss == pytest.approx(expected_loss, rel=1e-12)
    for name in expected:
        assert np.allclose(grads[name], expected[name], atol=0, rtol=0), f"{name} differs"


def test_alpha_one_never_consults_the_teacher(batch):
    """A teacher that raises on use proves the baseline path does not touch it."""
    student, _ = pair()
    inputs, targets = batch

    class Exploding(TransformerLM):
        def forward(self, *a, **k):  # pragma: no cover - reaching this is the failure
            raise AssertionError("the baseline condition must not forward the teacher")

    # The explosive object is the TEACHER (second argument). Passing it as the student
    # first -- as an earlier version of this test did -- forwards it immediately and
    # the test fails for the wrong reason.
    loss, grads = distillation_loss_and_grads(student, Exploding(student.config), inputs, targets, alpha=1.0)
    assert np.isfinite(loss)
    assert set(grads) == set(student.params)


def test_adding_the_teacher_term_changes_the_gradient(batch):
    """If it did not, the experiment would be comparing a method against itself."""
    student, teacher = pair()
    inputs, targets = batch
    _, baseline = distillation_loss_and_grads(student, teacher, inputs, targets, alpha=1.0)
    _, distilled = distillation_loss_and_grads(student, teacher, inputs, targets, alpha=0.5)
    differs = any(not np.allclose(baseline[n], distilled[n]) for n in baseline)
    assert differs


def test_the_teacher_is_never_modified(batch):
    """The teacher is frozen; its weights must be untouched by a distillation step."""
    student, teacher = pair()
    inputs, targets = batch
    before = weights_digest(teacher.params)
    distillation_loss_and_grads(student, teacher, inputs, targets, alpha=0.5)
    assert weights_digest(teacher.params) == before


def test_alpha_zero_is_pure_distillation_and_reproduces_the_kl_alone(batch):
    """With no hard labels at all, the loss must equal T^2 * KL exactly."""
    student, teacher = pair()
    inputs, targets = batch
    temperature = 3.0
    loss, _ = distillation_loss_and_grads(
        student, teacher, inputs, targets, temperature=temperature, alpha=0.0
    )
    expected = temperature**2 * kl_divergence(student.forward(inputs), teacher.forward(inputs), temperature)
    assert loss == pytest.approx(expected, rel=1e-12)


def test_the_loss_is_finite_for_extreme_settings(batch):
    student, teacher = pair()
    inputs, targets = batch
    for temperature in (0.1, 1.0, 50.0):
        for alpha in (0.0, 0.5, 1.0):
            loss, grads = distillation_loss_and_grads(
                student, teacher, inputs, targets, temperature=temperature, alpha=alpha
            )
            assert np.isfinite(loss), (temperature, alpha)
            assert all(np.all(np.isfinite(g)) for g in grads.values()), (temperature, alpha)


# ---------------------------------------------------------------------------
# Gradient
# ---------------------------------------------------------------------------


def test_every_gradient_matches_a_finite_difference(batch):
    """The temperature factor lives or dies here.

    A wrong factor produces a wrong direction that is still a valid descent direction
    for *something*, so the training run would look plausible and be worse.
    """
    student, teacher = pair()
    inputs, targets = batch
    temperature, alpha = 2.0, 0.4
    _, grads = distillation_loss_and_grads(
        student, teacher, inputs, targets, temperature=temperature, alpha=alpha
    )

    rng = np.random.default_rng(11)
    eps = 1e-6
    failures = []
    for name in student.params:
        flat = student.params[name].reshape(-1)
        analytic = grads[name].reshape(-1)
        for index in rng.choice(flat.size, size=min(6, flat.size), replace=False):
            original = flat[index]
            flat[index] = original + eps
            plus = distillation_loss_and_grads(
                student, teacher, inputs, targets, temperature=temperature, alpha=alpha
            )[0]
            flat[index] = original - eps
            minus = distillation_loss_and_grads(
                student, teacher, inputs, targets, temperature=temperature, alpha=alpha
            )[0]
            flat[index] = original
            numeric = (plus - minus) / (2 * eps)
            allowed = 1e-9 + 1e-5 * abs(analytic[index])
            if abs(numeric - analytic[index]) > allowed:
                failures.append(
                    f"{name}[{index}]: numeric {numeric:.3e} analytic {analytic[index]:.3e}"
                )
    assert not failures, "distillation gradient mismatch:\n  " + "\n  ".join(failures)


def test_the_gradient_check_catches_a_wrong_temperature_factor(batch):
    """Negative control: drop the single factor of T and confirm the check trips.

    Without this, the test above could be passing because its tolerance is too loose.
    """
    student, teacher = pair()
    inputs, targets = batch
    temperature, alpha = 2.0, 0.4
    _, grads = distillation_loss_and_grads(
        student, teacher, inputs, targets, temperature=temperature, alpha=alpha
    )

    rng = np.random.default_rng(11)
    eps = 1e-6
    name = "L0.wq"
    flat = student.params[name].reshape(-1)
    analytic = grads[name].reshape(-1)
    detected = False
    for index in rng.choice(flat.size, size=4, replace=False):
        original = flat[index]
        flat[index] = original + eps
        plus = distillation_loss_and_grads(student, teacher, inputs, targets, temperature=temperature, alpha=alpha)[0]
        flat[index] = original - eps
        minus = distillation_loss_and_grads(student, teacher, inputs, targets, temperature=temperature, alpha=alpha)[0]
        flat[index] = original
        numeric = (plus - minus) / (2 * eps)
        # What the gradient would be if the chain-rule factor T were omitted.
        wrong = analytic[index] - (1.0 - alpha) * (temperature - 1.0) * analytic[index]
        if abs(numeric - wrong) > abs(numeric - analytic[index]) * 0.5:
            detected = True
            break
    assert detected, "the finite-difference check cannot distinguish the correct factor from a wrong one"


# ---------------------------------------------------------------------------
# Configuration and identity
# ---------------------------------------------------------------------------


def test_configuration_is_validated():
    for bad, message in (
        ({"temperature": 0.0}, "temperature must be positive"),
        ({"temperature": -1.0}, "temperature must be positive"),
        ({"alpha": -0.1}, "alpha must be in"),
        ({"alpha": 1.1}, "alpha must be in"),
    ):
        with pytest.raises(ValueError, match=message):
            DistillConfig(**bad)


def test_alpha_one_reports_that_it_does_not_use_a_teacher():
    assert DistillConfig(alpha=1.0).uses_teacher is False
    assert DistillConfig(alpha=0.999).uses_teacher is True


def test_the_config_digest_moves_with_the_settings():
    assert DistillConfig(temperature=2.0).digest != DistillConfig(temperature=3.0).digest
    assert DistillConfig(alpha=0.5).digest != DistillConfig(alpha=0.6).digest
    assert DistillConfig(temperature=2.0).digest == DistillConfig(temperature=2.0).digest


def test_teacher_identity_records_the_digest_and_size():
    _, teacher = pair()
    identity = teacher_identity(teacher)
    assert identity["weightsDigest"] == weights_digest(teacher.params)
    assert identity["parameterCount"] == teacher.parameter_count
    assert identity["configDigest"] == teacher.config.digest


def test_both_arms_are_paired_on_data_and_initial_weights(monkeypatch):
    """The comparison is only meaningful if the arms differ in nothing but the objective.

    A paired design is what cancels seed noise here, and it is easy to break by
    accident: pass a different `data_seed` to one arm, or let the teacher's forward
    pass draw from a shared generator, and the two arms would be trained on different
    data orders. Then any difference between them measures the data as much as the
    method -- and it would look like a perfectly normal result.
    """
    from fabric.lm import data as data_module
    from fabric.lm import distill as module

    recorded = {"batches": [], "model_seeds": []}
    real_make_batches, real_model = data_module.make_batches, module.TransformerLM

    def spy_make_batches(*args, **kwargs):
        recorded["batches"].append(kwargs)
        return real_make_batches(*args, **kwargs)

    def spy_model(config, **kwargs):
        recorded["model_seeds"].append(kwargs.get("seed"))
        return real_model(config, **kwargs)

    # make_batches is imported inside train_student, so patching the data module is
    # what the call site actually resolves -- patching distill would not bite.
    monkeypatch.setattr(data_module, "make_batches", spy_make_batches)
    monkeypatch.setattr(module, "TransformerLM", spy_model)

    config = TransformerConfig(vocab_size=32, d_model=16, n_layers=2, n_heads=2, d_ff=32, seq_len=12)
    teacher = TransformerLM(config, seed=5)
    ids = np.arange(80, dtype=np.int64) % 32
    kwargs = dict(vocab_size=32, steps=2, batch_size=4, seq_len=12, warmup_steps=1, model_seed=7, data_seed=11)

    for alpha in (1.0, 0.5):
        module.train_student(config, teacher, ids, ids,
                             distill=DistillConfig(temperature=2.0, alpha=alpha), **kwargs)

    assert len(recorded["batches"]) == 2
    assert recorded["batches"][0] == recorded["batches"][1], (
        f"the arms were fed different batches: {recorded['batches']}"
    )
    assert recorded["model_seeds"] == [7, 7], (
        f"the arms did not start from the same initial weights: {recorded['model_seeds']}"
    )
