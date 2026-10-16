"""Baselines, the token-weighted mean, and deterministic generation.

The important property here is that the reported perplexity does not move when
`batch_size` moves. A mean-of-per-batch-means looks right and is wrong whenever the
windows are not all the same size; the metric would then depend on an evaluation
setting that has nothing to do with model quality.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from fabric.lm.evaluate import (
    Baseline,
    EvaluationResult,
    bigram_baseline,
    evaluate_model,
    generate,
    uniform_baseline,
    unigram_baseline,
)
from fabric.lm.model import TransformerConfig, TransformerLM
from fabric.lm.tokenizer import CharacterTokenizer


VOCAB = 6


@pytest.fixture
def ordered_stream():
    """A stream where the next token is almost determined by the previous one."""
    train = np.array([0, 1, 0, 1, 2, 3, 2, 3] * 60, dtype=np.int32)
    evaluation = np.array([0, 1, 0, 1, 2, 3, 2, 3] * 8, dtype=np.int32)
    return train, evaluation


# ---------------------------------------------------------------------------
# Baselines
# ---------------------------------------------------------------------------


def test_uniform_baseline_is_exactly_log_vocabulary():
    baseline = uniform_baseline(6)
    assert baseline.nll_nats_per_token == pytest.approx(math.log(6))
    assert baseline.perplexity == pytest.approx(6.0)


def test_the_bigram_beats_the_unigram_when_order_matters(ordered_stream):
    """If it did not, the baseline would not be measuring anything about order."""
    train, evaluation = ordered_stream
    unigram = unigram_baseline(train, evaluation, vocab_size=VOCAB)
    bigram = bigram_baseline(train, evaluation, vocab_size=VOCAB)
    assert bigram.nll_nats_per_token < unigram.nll_nats_per_token


def test_the_unigram_beats_uniform_when_frequencies_are_uneven():
    train = np.array([0] * 90 + [1] * 5 + [2] * 5, dtype=np.int32)
    evaluation = np.array([0] * 9 + [1, 2], dtype=np.int32)
    assert unigram_baseline(train, evaluation, vocab_size=VOCAB).perplexity < uniform_baseline(VOCAB).perplexity


def test_a_bigram_table_from_a_degenerate_stream_does_not_produce_nan():
    """A stream of one repeated token makes every row have a single observation."""
    train = np.zeros(50, dtype=np.int32)
    evaluation = np.zeros(20, dtype=np.int32)
    baseline = bigram_baseline(train, evaluation, vocab_size=VOCAB)
    assert np.isfinite(baseline.nll_nats_per_token)
    assert baseline.nll_nats_per_token >= 0


def test_baseline_arguments_are_validated():
    with pytest.raises(ValueError, match="at least 2"):
        uniform_baseline(1)
    with pytest.raises(ValueError, match="not be negative"):
        unigram_baseline(np.zeros(10, np.int32), np.zeros(4, np.int32), vocab_size=VOCAB, smoothing=-1)
    with pytest.raises(ValueError, match="too short"):
        bigram_baseline(np.zeros(1, np.int32), np.zeros(4, np.int32), vocab_size=VOCAB)


def test_baseline_derived_quantities_are_consistent():
    baseline = Baseline(name="x", nll_nats_per_token=math.log(8), description="d")
    assert baseline.perplexity == pytest.approx(8.0)
    assert baseline.bits_per_token == pytest.approx(math.log(8) / math.log(2))
    assert set(baseline.to_dict()) == {
        "name", "description", "nllNatsPerToken", "perplexity", "bitsPerToken",
    }


def test_bits_per_character_needs_a_character_count_and_is_not_bits_per_token():
    """With one token per character the two figures coincide; with subwords they do not.

    A 2-token-per-character vocabulary costs more bits per token and the same bits per
    character as the character tokenizer would -- so a report that printed the per-token
    figure under a per-character name would overstate the model by a factor of two.
    """
    without = EvaluationResult(nll_nats_per_token=1.0, tokens_evaluated=100)
    assert without.bits_per_token == pytest.approx(1.0 / math.log(2))
    assert without.bits_per_character is None

    character_like = EvaluationResult(
        nll_nats_per_token=1.0, tokens_evaluated=100, characters_evaluated=100,
    )
    assert character_like.bits_per_character == pytest.approx(character_like.bits_per_token)

    subword = EvaluationResult(
        nll_nats_per_token=1.0, tokens_evaluated=50, characters_evaluated=100,
    )
    assert subword.bits_per_character == pytest.approx(subword.bits_per_token / 2)
    assert "bitsPerToken" in subword.to_dict() and "bitsPerCharacter" in subword.to_dict()


# ---------------------------------------------------------------------------
# Evaluating a model
# ---------------------------------------------------------------------------


def make_model_and_data(seed=0, seq_len=12, length=400, vocab=8):
    config = TransformerConfig(vocab_size=vocab, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=seq_len)
    model = TransformerLM(config, seed=seed, dtype=np.float64)
    rng = np.random.default_rng(seed)
    ids = rng.integers(0, vocab, length).astype(np.int32)
    return model, ids, config


def test_the_metric_does_not_depend_on_the_evaluation_batch_size():
    """The property that makes the number a metric rather than an artefact.

    Windows are evaluated in groups; the accumulation is over tokens. If it were a
    mean of per-group means, the answer would change with the grouping.
    """
    model, ids, config = make_model_and_data()
    train_ids = np.random.default_rng(9).integers(0, 8, 2000).astype(np.int32)
    one = evaluate_model(model, ids, vocab_size=8, train_ids=train_ids, seq_len=config.seq_len, batch_size=1)
    many = evaluate_model(model, ids, vocab_size=8, train_ids=train_ids, seq_len=config.seq_len, batch_size=7)
    assert one.tokens_evaluated == many.tokens_evaluated
    assert one.nll_nats_per_token == pytest.approx(many.nll_nats_per_token, rel=1e-12)


def test_the_metric_does_not_depend_on_the_evaluation_batch_size_with_uneven_windows():
    """The case where mean-of-means actually differs: the tail window is shorter."""
    model, ids, config = make_model_and_data(length=401)
    train_ids = np.random.default_rng(9).integers(0, 8, 2000).astype(np.int32)
    one = evaluate_model(model, ids, vocab_size=8, train_ids=train_ids, seq_len=config.seq_len, batch_size=1)
    many = evaluate_model(model, ids, vocab_size=8, train_ids=train_ids, seq_len=config.seq_len, batch_size=5)
    assert one.nll_nats_per_token == pytest.approx(many.nll_nats_per_token, rel=1e-12)


def test_a_random_model_scores_about_log_vocabulary():
    model, ids, config = make_model_and_data(vocab=8)
    result = evaluate_model(model, ids, vocab_size=8, train_ids=ids, seq_len=config.seq_len, with_baselines=False)
    assert result.perplexity == pytest.approx(8.0, rel=0.25), f"got {result.perplexity}"


def test_the_verdict_is_computed_from_the_baselines_not_asserted():
    model, ids, config = make_model_and_data(vocab=8)
    result = evaluate_model(model, ids, vocab_size=8, train_ids=ids, seq_len=config.seq_len)
    best = result.best_baseline
    assert best is not None
    assert result.beats_all_baselines == (result.nll_nats_per_token < best.nll_nats_per_token)
    payload = result.to_dict()
    assert payload["bestBaseline"] in {"uniform", "unigram", "bigram"}
    assert payload["beatsAllBaselines"] == result.beats_all_baselines
    assert payload["perplexityVsBestBaseline"] == pytest.approx(result.perplexity / best.perplexity)


def test_baselines_require_the_training_stream_to_estimate_from():
    model, ids, config = make_model_and_data()
    with pytest.raises(ValueError, match="training token stream"):
        evaluate_model(model, ids, vocab_size=8, seq_len=config.seq_len, with_baselines=True)


def test_a_stream_shorter_than_the_window_is_refused():
    model, ids, config = make_model_and_data(length=5)
    with pytest.raises(ValueError, match="shorter than seq_len"):
        evaluate_model(model, ids, vocab_size=8, seq_len=config.seq_len, with_baselines=False)


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def test_generation_is_reproducible_for_a_seed():
    config = TransformerConfig(vocab_size=11, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=16)
    model = TransformerLM(config, seed=2, dtype=np.float64)
    tokenizer = CharacterTokenizer.fit(["abcdefghijklmnopqrstuvwxyz "])
    a = generate(model, tokenizer, "abc", max_new_tokens=30, seed=4)
    b = generate(model, tokenizer, "abc", max_new_tokens=30, seed=4)
    c = generate(model, tokenizer, "abc", max_new_tokens=30, seed=5)
    assert a == b, "the same seed must reproduce the same sample"
    assert a != c or len(set(a)) == 1, "different seeds should usually diverge"


def test_greedy_decoding_is_deterministic_regardless_of_seed():
    config = TransformerConfig(vocab_size=11, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=16)
    model = TransformerLM(config, seed=2, dtype=np.float64)
    tokenizer = CharacterTokenizer.fit(["abcdefghijklmnopqrstuvwxyz "])
    a = generate(model, tokenizer, "abc", max_new_tokens=20, temperature=0.0, seed=1)
    b = generate(model, tokenizer, "abc", max_new_tokens=20, temperature=0.0, seed=99)
    assert a == b


def test_generation_respects_the_requested_length():
    config = TransformerConfig(vocab_size=11, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=16)
    model = TransformerLM(config, seed=2, dtype=np.float64)
    tokenizer = CharacterTokenizer.fit(["abc"])
    assert len(tokenizer.encode(generate(model, tokenizer, "abc", max_new_tokens=25, temperature=0.0))) == 25


def test_generation_works_when_the_prompt_is_longer_than_the_context():
    """The prompt is truncated to the window; it must not raise."""
    config = TransformerConfig(vocab_size=11, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=8)
    model = TransformerLM(config, seed=2, dtype=np.float64)
    tokenizer = CharacterTokenizer.fit(["abcdefghijklmnopqrstuvwxyz "])
    out = generate(model, tokenizer, "a" * 200, max_new_tokens=10, temperature=0.0)
    assert isinstance(out, str)


def test_generation_arguments_are_validated():
    config = TransformerConfig(vocab_size=11, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=8)
    model = TransformerLM(config, seed=2, dtype=np.float64)
    tokenizer = CharacterTokenizer.fit(["abc"])
    with pytest.raises(ValueError, match="max_new_tokens"):
        generate(model, tokenizer, "a", max_new_tokens=0)
    with pytest.raises(ValueError, match="temperature"):
        generate(model, tokenizer, "a", temperature=-1.0)
