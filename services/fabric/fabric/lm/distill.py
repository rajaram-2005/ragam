"""Knowledge distillation: a smaller student trained on a teacher's soft targets.

Two kinds of distillation are possible, and only one of them is available here.

**Sequence-level** (hard targets): a teacher generates text, and the student trains on
it as ordinary data. This needs an external teacher, because our own model is too weak
to be worth imitating for text quality. That path is in `teacher.py` and requires
credentials.

**Logit-level** (soft targets, Hinton-style): the student matches the teacher's full
next-token distribution, temperature-scaled, instead of only its argmax. This needs
the teacher's logits, so it needs a teacher whose weights are on this machine. **Our
own released model is exactly such a teacher**, which is why this module can run today
with no credentials and no network.

What soft targets carry that hard labels do not: the teacher's uncertainty. When the
true next character is ambiguous, the teacher's distribution says *which* alternatives
it considered and how strongly, and that ranking is a free training signal the argmax
throws away. Whether it helps a student of a given size on this corpus is an empirical
question, so it is asked as a controlled experiment (`scripts/distill_experiment.py`)
with a baseline at the same seed, same data order and same step count.

The gradient. With `T` the temperature and `alpha` the hard-label weight:

    L = alpha * CE(student, hard) + (1 - alpha) * T^2 * KL(teacher_T || student_T)

`KL(p || q) = sum p (log p - log q)`, and since the teacher is fixed, differentiating
with respect to the student's logits gives

    dL/dz = alpha * (softmax(z) - onehot) / (B*T_len)
          + (1 - alpha) * T * (softmax(z/T) - softmax(z_teacher/T)) / (B*T_len)

The `T^2` in the loss and the `1/T` from the chain rule through `z/T` leave a single
factor of `T` on the second term. Getting that factor wrong does not crash anything --
it silently reweights the two terms -- so the whole objective is checked against a
central finite difference in `tests/test_lm_distill.py`, the same way the base model's
backward pass is.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict

import numpy as np

from .model import TransformerLM, weights_digest


@dataclass(frozen=True)
class DistillConfig:
    """Settings for logit distillation. Named separately so they are recorded."""

    temperature: float = 2.0
    #: Weight on the hard-label cross-entropy. 1.0 disables distillation entirely,
    #: which is what makes the baseline condition a *configuration* rather than a
    #: separate code path -- the two arms of the experiment run identical code.
    alpha: float = 0.5

    def __post_init__(self) -> None:
        if self.temperature <= 0:
            raise ValueError(f"temperature must be positive, got {self.temperature}")
        if not 0.0 <= self.alpha <= 1.0:
            raise ValueError(f"alpha must be in [0, 1], got {self.alpha}")

    @property
    def uses_teacher(self) -> bool:
        """False when alpha is 1: the teacher contributes nothing and is not consulted."""
        return self.alpha < 1.0

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def digest(self) -> str:
        return hashlib.sha256(
            json.dumps(self.to_dict(), sort_keys=True).encode("utf-8")
        ).hexdigest()


def softmax_temperature(logits: np.ndarray, temperature: float) -> np.ndarray:
    """Softmax at a temperature, computed stably."""
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    scaled = logits / temperature
    scaled = scaled - scaled.max(axis=-1, keepdims=True)
    e = np.exp(scaled)
    return e / e.sum(axis=-1, keepdims=True)


def kl_divergence(student_logits: np.ndarray, teacher_logits: np.ndarray, temperature: float) -> float:
    """Mean KL(teacher || student) in nats, at the given temperature.

    Teacher probabilities are treated as constants: the teacher is frozen, and this
    measures how far the student's distribution is from it.
    """
    if student_logits.shape != teacher_logits.shape:
        raise ValueError(
            f"student and teacher logits must have the same shape, got "
            f"{student_logits.shape} and {teacher_logits.shape}"
        )
    teacher = softmax_temperature(teacher_logits, temperature)
    student = softmax_temperature(student_logits, temperature)
    # exp(-inf) never appears because softmax_temperature subtracts the max, but a
    # teacher probability of exactly zero would produce -inf * 0. Clamping keeps the
    # value finite without changing it meaningfully.
    return float(np.mean(np.sum(teacher * (np.log(np.maximum(teacher, 1e-12)) - np.log(np.maximum(student, 1e-12))), axis=-1)))


def distillation_loss_and_grads(
    student: TransformerLM,
    teacher: TransformerLM,
    inputs: np.ndarray,
    targets: np.ndarray,
    *,
    temperature: float = 2.0,
    alpha: float = 0.5,
):
    """Returns (loss, grads) for the combined objective. Teacher weights are frozen.

    `alpha = 1.0` reduces exactly to plain cross-entropy, so the baseline arm of an
    experiment and the distilled arm run the same function with different settings.
    """
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    if not 0.0 <= alpha <= 1.0:
        raise ValueError("alpha must be in [0, 1]")

    student_logits, cache = student.forward(inputs, cache=True)
    hard_loss, hard_grad = student._cross_entropy(student_logits, targets)  # noqa: SLF001

    if alpha >= 1.0:
        # No teacher forward at all. This is the baseline condition, and skipping the
        # forward pass here is not just an optimisation: it means the baseline costs
        # no more than it did before distillation existed, so the comparison is not
        # quietly paying for the teacher.
        return hard_loss, student.backward_from_dlogits(alpha * hard_grad, cache)

    teacher_logits = teacher.forward(inputs)

    B, T, V = student_logits.shape
    teacher_probs = softmax_temperature(teacher_logits, temperature)
    student_probs = softmax_temperature(student_logits, temperature)
    kl = np.mean(
        np.sum(
            teacher_probs * (np.log(np.maximum(teacher_probs, 1e-12)) - np.log(np.maximum(student_probs, 1e-12))),
            axis=-1,
        )
    )
    loss = float(alpha * hard_loss + (1.0 - alpha) * temperature**2 * kl)

    # dL/dz, derived above. The teacher term needs no gradient through the teacher.
    dlogits = alpha * hard_grad + (1.0 - alpha) * temperature * (student_probs - teacher_probs) / (B * T)
    return loss, student.backward_from_dlogits(dlogits, cache)


def teacher_identity(teacher: TransformerLM) -> dict:
    """What the student was distilled from, recorded so a run is traceable."""
    return {
        "parameterCount": teacher.parameter_count,
        "weightsDigest": weights_digest(teacher.params),
        "configDigest": teacher.config.digest,
        "note": "logit distillation: the teacher's full distribution, not its text",
    }


def train_student(
    student_config,
    teacher: TransformerLM,
    train_ids: np.ndarray,
    validation_ids: np.ndarray,
    *,
    vocab_size: int,
    distill: DistillConfig,
    steps: int,
    batch_size: int = 12,
    seq_len: int = 96,
    learning_rate: float = 3e-3,
    warmup_steps: int = 60,
    weight_decay: float = 0.01,
    grad_clip: float = 1.0,
    model_seed: int = 0,
    data_seed: int = 0,
    eval_batch_size: int = 8,
    progress=None,
) -> dict:
    """Train one student, either as a baseline or distilled, and evaluate it.

    Deliberately one function for both arms. The experiment's claim rests on the two
    conditions differing *only* in `distill`, and two separate training loops would
    make that a matter of inspection rather than of construction. `alpha = 1.0` skips
    the teacher forward entirely, so the baseline is also not paying extra compute for
    machinery it does not use.
    """
    from .data import make_batches
    from .evaluate import evaluate_model
    from .train import AdamW, TrainConfig

    if steps < 1:
        raise ValueError("steps must be at least 1")
    if warmup_steps >= steps:
        raise ValueError(f"warmup_steps {warmup_steps} must be below steps {steps}")
    if teacher.config.vocab_size != vocab_size:
        raise ValueError(
            f"teacher vocabulary {teacher.config.vocab_size} does not match {vocab_size}; "
            "distillation is only defined over a shared vocabulary"
        )

    student = TransformerLM(student_config, seed=model_seed)
    # AdamW is reused from the ordinary trainer so the optimiser is identical between
    # the arms and identical to the one that trained the released model.
    schedule = TrainConfig(
        d_model=student_config.d_model, n_layers=student_config.n_layers,
        n_heads=student_config.n_heads, d_ff=student_config.d_ff, seq_len=seq_len,
        batch_size=batch_size, steps=steps, learning_rate=learning_rate,
        warmup_steps=warmup_steps, weight_decay=weight_decay, grad_clip=grad_clip,
    )
    optimizer = AdamW(schedule, {name: array.shape for name, array in student.params.items()})

    losses = []
    teacher_forwards = 0
    for step, batch in enumerate(
        make_batches(train_ids, batch_size=batch_size, seq_len=seq_len, seed=data_seed, steps=steps)
    ):
        loss, grads = distillation_loss_and_grads(
            student, teacher, batch.inputs, batch.targets,
            temperature=distill.temperature, alpha=distill.alpha,
        )
        if distill.uses_teacher:
            teacher_forwards += 1
        optimizer.step(student.params, grads, schedule.learning_rate_at(step))
        losses.append({"step": step, "loss": loss, "lr": schedule.learning_rate_at(step)})
        if progress is not None and (step % max(1, steps // 8) == 0 or step == steps - 1):
            progress(step, steps, loss)

    evaluation = evaluate_model(
        student, validation_ids, vocab_size=vocab_size, train_ids=train_ids,
        seq_len=seq_len, batch_size=eval_batch_size,
    )
    return {
        "weightDigest": weights_digest(student.params),
        "parameterCount": student.parameter_count,
        "finalLoss": losses[-1]["loss"],
        "firstLoss": losses[0]["loss"],
        "lossCurve": losses,
        "teacherForwards": teacher_forwards,
        "evaluation": evaluation.to_dict(),
        "student": student,
    }
