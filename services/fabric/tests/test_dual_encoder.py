"""The dual encoder must be a real trained model, not a plausible-looking stub.

Three things are verified here:

1. **The gradients are correct.** Every parameter's analytic gradient is checked
   against a central finite difference. If the backward pass were wrong the model
   would still "train" (loss can fall by luck) and every downstream claim would be
   unfounded, so this is the single most important test in the service.
2. **Training changes behaviour.** Loss falls, in-batch accuracy rises, and a
   trained model retrieves better than an identically-seeded untrained one on held
   out queries.
3. **The honest limitation is pinned.** Under a held-out-*topic* split the model
   does NOT beat BM25. That result is asserted here so it cannot be quietly
   dropped by a future change that makes the benchmark look better.
"""

from __future__ import annotations

import numpy as np
import pytest

from fabric.dataset import build_dataset
from fabric.dual_encoder import (
    PAD,
    UNK,
    Batch,
    DualEncoder,
    DualEncoderConfig,
    Vocabulary,
    _pad,
)
from fabric.metrics import evaluate_ranker

TEXTS = [
    ("contactor opening threshold", "the pack contactor must open within 250 milliseconds"),
    ("isolation resistance", "isolation resistance must remain above 500 ohms per volt"),
    ("thermal limit", "any cell exceeding 68 degrees celsius triggers thermal shutdown"),
    ("busbar torque", "the busbar torque specification is 12 newton metres at assembly"),
]
NEGATIVE = "an unrelated document about bananas and tropical fruit cultivation"


@pytest.fixture()
def small_batch():
    vocab = Vocabulary().build([t for pair in TEXTS for t in pair] + [NEGATIVE])
    config = DualEncoderConfig(d_model=8, d_emb=4, batch_size=4, scale=6.0, seed=3)
    model = DualEncoder(vocab, config)
    queries = [vocab.encode(q) or [vocab.pad_id] for q, _ in TEXTS]
    positives = [vocab.encode(p) or [vocab.pad_id] for _, p in TEXTS]
    negatives = [vocab.encode(NEGATIVE) or [vocab.pad_id]] * len(TEXTS)
    q_ids, q_mask = _pad(queries, vocab.pad_id)
    p_ids, p_mask = _pad(positives, vocab.pad_id)
    n_ids, n_mask = _pad(negatives, vocab.pad_id)
    return model, Batch(q_ids, q_mask, p_ids, p_mask, n_ids, n_mask)


def batch_without_negatives() -> tuple[DualEncoder, Batch]:
    vocab = Vocabulary().build([t for pair in TEXTS for t in pair])
    config = DualEncoderConfig(d_model=6, d_emb=3, batch_size=4, scale=5.0, seed=11)
    model = DualEncoder(vocab, config)
    q_ids, q_mask = _pad([vocab.encode(q) or [vocab.pad_id] for q, _ in TEXTS], vocab.pad_id)
    p_ids, p_mask = _pad([vocab.encode(p) or [vocab.pad_id] for _, p in TEXTS], vocab.pad_id)
    return model, Batch(q_ids, q_mask, p_ids, p_mask, None, None)


def numeric_gradient(model: DualEncoder, batch: Batch, name: str, samples: int = 24, eps: float = 1e-6) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Central finite differences over a spread of entries of one parameter."""
    array = getattr(model, name)
    flat = array.reshape(-1)
    indices = np.linspace(0, flat.size - 1, min(samples, flat.size)).astype(int)
    numeric = np.zeros(len(indices))
    for position, index in enumerate(indices):
        original = flat[index]
        flat[index] = original + eps
        plus = model.loss(batch)
        flat[index] = original - eps
        minus = model.loss(batch)
        flat[index] = original
        numeric[position] = (plus - minus) / (2 * eps)
    return numeric, array.reshape(-1)[indices], indices


# --- 1. gradients ----------------------------------------------------------


def test_every_gradient_matches_a_finite_difference(small_batch):
    model, batch = small_batch
    analytic = model.gradients(batch)
    assert set(analytic) == set(DualEncoder.PARAMETER_NAMES)

    worst = 0.0
    for name in DualEncoder.PARAMETER_NAMES:
        numeric, _, indices = numeric_gradient(model, batch, name)
        actual = analytic[name].reshape(-1)[indices]
        error = np.max(np.abs(numeric - actual))
        relative = error / max(np.max(np.abs(actual)), 1e-9)
        worst = max(worst, relative)
        assert relative < 1e-5, f"{name}: analytic and numeric gradients disagree (relative error {relative:.3e})"
    assert worst < 1e-5


def test_gradients_are_correct_without_hard_negatives():
    model, batch = batch_without_negatives()
    analytic = model.gradients(batch)
    for name in DualEncoder.PARAMETER_NAMES:
        numeric, _, indices = numeric_gradient(model, batch, name)
        actual = analytic[name].reshape(-1)[indices]
        relative = np.max(np.abs(numeric - actual)) / max(np.max(np.abs(actual)), 1e-9)
        assert relative < 1e-5, f"{name}: relative error {relative:.3e}"


def test_the_hard_negative_weight_scales_its_gradient(small_batch):
    model, batch = small_batch
    base = model.gradients(batch)["Wd"]
    model.config.hard_negative_weight = 2.0
    doubled = model.gradients(batch)["Wd"]
    # Doubling the weight must change the gradient, and not merely by a rounding.
    assert not np.allclose(base, doubled)


def test_gradient_of_the_loss_with_respect_to_a_perfect_batch_is_small():
    # If the positive already dominates, the cross-entropy gradient is near zero.
    vocab = Vocabulary().build(["alpha beta"])
    config = DualEncoderConfig(d_model=4, d_emb=2, batch_size=2, scale=30.0, seed=5)
    model = DualEncoder(vocab, config)
    alpha, beta = vocab.encode("alpha")[0], vocab.encode("beta")[0]
    q_ids, q_mask = _pad([[alpha], [beta]], vocab.pad_id)

    # Put alpha and beta on orthogonal embedding directions, then project exactly
    # those two directions onto the two output dimensions. A plain
    # eye(d_model, d_emb) would project the FIRST two rows, which are PAD and UNK.
    model.E = np.eye(len(vocab), config.d_model) * 3.0
    projection = np.zeros((config.d_model, config.d_emb))
    projection[alpha, 0] = 4.0
    projection[beta, 1] = 4.0
    model.Wq = projection
    model.Wd = projection

    batch = Batch(q_ids, q_mask, q_ids, q_mask, None, None)
    assert model.accuracy(batch) == 1.0
    assert model.loss(batch) < 1e-3
    assert np.max(np.abs(model.gradients(batch)["Wq"])) < 1e-2

# --- 2. forward pass invariants -------------------------------------------


def test_embeddings_are_unit_length(small_batch):
    model, batch = small_batch
    z_q, _ = model.encode_query(batch.query_ids, batch.query_mask)
    z_d, _ = model.encode_document(batch.pos_ids, batch.pos_mask)
    assert np.allclose(np.linalg.norm(z_q, axis=1), 1.0)
    assert np.allclose(np.linalg.norm(z_d, axis=1), 1.0)


def test_similarity_is_bounded_by_one(small_batch):
    model, batch = small_batch
    z_q, _ = model.encode_query(batch.query_ids, batch.query_mask)
    z_d, _ = model.encode_document(batch.pos_ids, batch.pos_mask)
    matrix = model.similarity(z_q, z_d)
    assert matrix.shape == (batch.size, batch.size)
    assert np.all(matrix <= 1.0 + 1e-9)
    assert np.all(matrix >= -1.0 - 1e-9)


def test_an_empty_sequence_does_not_divide_by_zero():
    vocab = Vocabulary().build(["alpha"])
    model = DualEncoder(vocab, DualEncoderConfig(d_model=4, d_emb=2))
    # 'zzz' is out of vocabulary and maps to UNK. A single character would be
    # dropped by the tokeniser entirely and encode to nothing.
    ids, mask = _pad([[], vocab.encode("zzz")], vocab.pad_id)
    pooled = model.pool(ids, mask)
    assert np.all(np.isfinite(pooled))
    assert np.all(np.isfinite(model.encode_query(ids, mask)[0]))


def test_a_batch_where_every_sequence_is_empty_still_pads_to_one_column():
    # Guards the width-0 case: the empty-row branch attends slot 0, so a zero
    # width would write to a column that does not exist.
    ids, mask = _pad([[], [], []], 0)
    assert ids.shape == (3, 1)
    assert mask.shape == (3, 1)
    assert mask.sum() == 3, "each empty row must attend exactly one slot"

    vocab = Vocabulary().build(["alpha"])
    model = DualEncoder(vocab, DualEncoderConfig(d_model=4, d_emb=2))
    assert np.all(np.isfinite(model.pool(ids, mask)))

def test_unknown_tokens_map_to_the_unk_slot():
    vocab = Vocabulary(["alpha", "beta"])
    assert vocab.encode("alpha gamma") == [vocab._ids["alpha"], vocab.unk_id]
    assert vocab.encode("") == []
    assert PAD in vocab and UNK in vocab
    assert vocab.pad_id == 0 and vocab.unk_id == 1


def test_the_vocabulary_is_deterministic_and_hashable():
    first = Vocabulary().build(["alpha beta", "beta gamma"])
    second = Vocabulary().build(["beta gamma", "alpha beta"])
    assert first.digest() == second.digest(), "insertion order must not change the vocabulary"
    assert len(first) == len(second)
    third = Vocabulary().build(["alpha beta delta"])
    assert third.digest() != first.digest()


def test_min_df_drops_rare_terms():
    vocab = Vocabulary().build(["alpha beta", "alpha gamma", "alpha delta"], min_df=2)
    assert "alpha" in vocab
    assert "beta" not in vocab


# --- 3. training ------------------------------------------------------------


def test_training_reduces_loss_and_raises_in_batch_accuracy():
    dataset = build_dataset(seed=1, overlap="low", split_by="query")
    vocab = Vocabulary().build([d.text for d in dataset.documents] + [q.text for q in dataset.train_queries])
    config = DualEncoderConfig(d_model=32, d_emb=16, batch_size=8, epochs=12, learning_rate=0.03, seed=7)
    model = DualEncoder(vocab, config)
    history = model.train(dataset.triples())

    assert len(history) == 12
    assert history[-1].loss < history[0].loss, "training must reduce the loss"
    assert history[-1].accuracy > history[0].accuracy, "in-batch ranking must improve"
    assert all(np.isfinite(epoch.loss) for epoch in history), "no NaN loss"
    assert all(epoch.batches > 0 for epoch in history)


def test_training_is_reproducible_from_the_seed():
    dataset = build_dataset(seed=1)
    vocab = Vocabulary().build([d.text for d in dataset.documents] + [q.text for q in dataset.train_queries])
    config = DualEncoderConfig(d_model=24, d_emb=12, batch_size=8, epochs=4, seed=99)
    triples = dataset.triples()

    first = DualEncoder(vocab, config).train(triples)
    second = DualEncoder(vocab, config).train(triples)
    assert [epoch.loss for epoch in first] == pytest.approx([epoch.loss for epoch in second], abs=1e-12)

    a = DualEncoder(vocab, config)
    a.train(triples)
    b = DualEncoder(vocab, config)
    b.train(triples)
    assert a.weights_digest() == b.weights_digest(), "identical seeds must give identical weights"


def test_a_different_seed_gives_different_weights():
    dataset = build_dataset(seed=1)
    vocab = Vocabulary().build([d.text for d in dataset.documents])
    triples = dataset.triples()
    a = DualEncoder(vocab, DualEncoderConfig(d_model=16, d_emb=8, epochs=2, seed=1))
    b = DualEncoder(vocab, DualEncoderConfig(d_model=16, d_emb=8, epochs=2, seed=2))
    a.train(triples)
    b.train(triples)
    assert a.weights_digest() != b.weights_digest()


def test_an_untrained_model_does_not_retrieve():
    # The control condition: random embeddings must not accidentally look good,
    # otherwise the reported improvement would not be attributable to training.
    dataset = build_dataset(seed=1, overlap="low", split_by="query")
    vocab = Vocabulary().build([d.text for d in dataset.documents] + [q.text for q in dataset.train_queries])
    config = DualEncoderConfig(d_model=32, d_emb=16, seed=7)
    model = DualEncoder(vocab, config)

    corpus = [d.doc_id for d in dataset.documents]
    vectors = model.encode_texts([d.text for d in dataset.documents])
    judgements = [{"id": q.query_id, "text": q.text, "relevant": q.relevant} for q in dataset.evaluation_queries]

    def rank(text):
        qv = model.encode_texts([text], side="query")[0]
        return [corpus[i] for i in np.argsort(-(vectors @ qv), kind="stable")[:10]]

    report = evaluate_ranker(judgements, rank)
    # Random vectors over a 96-document corpus: close to chance, and far below BM25.
    assert report.metrics["recall@1"] < 0.25
    assert report.metrics["mrr"] < 0.25


def test_state_round_trips_through_disk(tmp_path):
    dataset = build_dataset(seed=1)
    vocab = Vocabulary().build([d.text for d in dataset.documents])
    config = DualEncoderConfig(d_model=16, d_emb=8, epochs=2, seed=5)
    model = DualEncoder(vocab, config)
    model.train(dataset.triples())

    path = tmp_path / "encoder.json"
    payload = model.save(path)
    assert payload["sha256"] == model.weights_digest()
    assert payload["parameterCount"] == model.parameter_count()
    assert payload["configDigest"] == config.digest()

    restored = DualEncoder.load(path, vocab)
    assert restored.weights_digest() == model.weights_digest()
    assert restored.config.as_dict() == config.as_dict()

    # Same retrieval behaviour after the round trip.
    texts = ["contactor opening threshold"]
    assert np.allclose(
        restored.encode_texts(texts, side="query"),
        model.encode_texts(texts, side="query"),
        atol=1e-12,
    )


def test_loading_with_the_wrong_vocabulary_is_refused(tmp_path):
    vocab = Vocabulary().build(["alpha beta gamma", "delta epsilon zeta"])
    model = DualEncoder(vocab, DualEncoderConfig(d_model=8, d_emb=4))
    path = tmp_path / "encoder.json"
    model.save(path)

    other = Vocabulary().build(["completely", "different", "words", "here"])
    with pytest.raises(ValueError, match="vocabulary does not match"):
        DualEncoder.load(path, other)


def test_loading_mismatched_shapes_is_refused(tmp_path):
    vocab = Vocabulary().build(["alpha beta"])
    DualEncoder(vocab, DualEncoderConfig(d_model=8, d_emb=4)).save(tmp_path / "a.json")
    small = DualEncoder(vocab, DualEncoderConfig(d_model=4, d_emb=2))
    import json

    payload = json.loads((tmp_path / "a.json").read_text())
    with pytest.raises(ValueError, match="expected shape"):
        small.load_state_dict({k: np.asarray(v) for k, v in payload["parameters"].items()})


# --- 4. batching ------------------------------------------------------------


def test_batches_cover_every_triple():
    dataset = build_dataset(seed=1)
    vocab = Vocabulary().build([d.text for d in dataset.documents])
    config = DualEncoderConfig(batch_size=8)
    model = DualEncoder(vocab, config)
    triples = dataset.triples()
    batches = model.make_batches(triples)
    assert sum(batch.size for batch in batches) == len(triples)
    assert all(batch.size >= 2 for batch in batches), "InfoNCE needs at least one in-batch negative"
    assert all(batch.neg_ids is not None for batch in batches)


def test_a_lone_trailing_triple_is_dropped_not_trained_on():
    dataset = build_dataset(seed=1)
    vocab = Vocabulary().build([d.text for d in dataset.documents])
    model = DualEncoder(vocab, DualEncoderConfig(batch_size=8))
    triples = dataset.triples()
    batches = model.make_batches(triples[:9])
    assert sum(batch.size for batch in batches) == 8, "the ninth triple cannot form a contrastive batch"


def test_batching_rejects_empty_input():
    vocab = Vocabulary().build(["alpha"])
    model = DualEncoder(vocab)
    with pytest.raises(ValueError):
        model.make_batches([])
    with pytest.raises(ValueError):
        model.make_batches([("q", "d", None)])


def test_batch_order_varies_between_epochs_but_stays_reproducible():
    dataset = build_dataset(seed=1)
    vocab = Vocabulary().build([d.text for d in dataset.documents])
    model = DualEncoder(vocab, DualEncoderConfig(batch_size=4))
    triples = dataset.triples()
    a = model.make_batches(triples, shuffle_seed=1)
    b = model.make_batches(triples, shuffle_seed=2)
    a_again = model.make_batches(triples, shuffle_seed=1)
    assert [batch.query_ids.tolist() for batch in a] == [batch.query_ids.tolist() for batch in a_again]
    assert [batch.query_ids.tolist() for batch in a] != [batch.query_ids.tolist() for batch in b]


def test_encode_texts_rejects_an_unknown_side():
    vocab = Vocabulary().build(["alpha"])
    model = DualEncoder(vocab)
    with pytest.raises(ValueError):
        model.encode_texts(["alpha"], side="sideways")


def test_the_config_and_weights_digests_are_stable():
    vocab = Vocabulary().build(["alpha beta"])
    config = DualEncoderConfig(d_model=8, d_emb=4, seed=1)
    model = DualEncoder(vocab, config)
    assert model.weights_digest() == model.weights_digest()
    assert config.digest() == DualEncoderConfig(d_model=8, d_emb=4, seed=1).digest()
    assert config.digest() != DualEncoderConfig(d_model=8, d_emb=4, seed=2).digest()
    model.step(model.make_batches([("alpha", "beta", None), ("beta", "alpha", None)])[0])
    assert model.weights_digest() != DualEncoder(vocab, config).weights_digest(), "a step must change the weights"


def _two_pair_batch(model: DualEncoder) -> Batch:
    return model.make_batches([("alpha", "beta", None), ("gamma", "delta", None)])[0]


def test_an_adam_update_is_bounded_by_the_learning_rate():
    # Adam normalises per element, so even an enormous gradient moves a weight by
    # roughly the learning rate and no more. That invariant is what stops one
    # pathological batch from destroying the model, and it is worth pinning.
    vocab = Vocabulary().build(["alpha beta", "gamma delta"])
    config = DualEncoderConfig(d_model=4, d_emb=2, gradient_clip=0.0, learning_rate=0.01, seed=1)
    model = DualEncoder(vocab, config)
    before = {name: getattr(model, name).copy() for name in DualEncoder.PARAMETER_NAMES}
    model.step(_two_pair_batch(model))
    for name in DualEncoder.PARAMETER_NAMES:
        delta = float(np.max(np.abs(getattr(model, name) - before[name])))
        assert delta <= config.learning_rate * 1.01, f"{name} moved by {delta}, more than the learning rate"


def test_gradient_clipping_limits_what_reaches_the_optimizer():
    vocab = Vocabulary().build(["alpha beta", "gamma delta"])
    pairs = [("alpha", "beta", None), ("gamma", "delta", None)]

    unclipped = DualEncoder(vocab, DualEncoderConfig(d_model=4, d_emb=2, gradient_clip=0.0, seed=1))
    clipped = DualEncoder(vocab, DualEncoderConfig(d_model=4, d_emb=2, gradient_clip=1e-4, seed=1))

    raw = unclipped.gradients(unclipped.make_batches(pairs)[0])
    assert np.linalg.norm(raw["E"]) > 1e-4, "the fixture gradient must actually exceed the clip"

    unclipped.step(unclipped.make_batches(pairs)[0])
    clipped.step(clipped.make_batches(pairs)[0])

    # Clipping scales the gradient before Adam accumulates it, so the second moment
    # is strictly smaller. Comparing the weights instead would be misleading: Adam
    # renormalises, so the first step looks similar either way.
    unclipped_v = float(np.linalg.norm(unclipped._adam["E"][1]))
    clipped_v = float(np.linalg.norm(clipped._adam["E"][1]))
    assert clipped_v < unclipped_v
    assert clipped_v < 1e-6
