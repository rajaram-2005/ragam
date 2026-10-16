"""Byte-level BPE: determinism, round-trips, and the properties a run depends on.

The tokenizer is the one component whose output shape decides what every number downstream
means -- a vocabulary that changes between two runs makes two runs incomparable even if
everything else is seeded. So these tests are about *equality* more than about quality:
same sample, same merges; same text, same ids; encode then decode, same text.
"""

from __future__ import annotations

import re

import numpy as np
import pytest

from fabric.lm.bpe import BASE_VOCAB_SIZE, ByteBPETokenizer, sample_evenly
from fabric.lm.tokenizer import CharacterTokenizer

CORPUS = """def parse(source):
    tokens = source.split()
    return [t for t in tokens if t]

def parse_all(sources):
    return [parse(s) for s in sources]

class Parser:
    def __init__(self, source):
        self.source = source
        self.tokens = parse(source)
"""


def fitted(vocab_size: int = 512) -> ByteBPETokenizer:
    return ByteBPETokenizer.fit([CORPUS * 40], vocab_size=vocab_size, sample_chars=len(CORPUS) * 40,
                                min_pair_count=2)


# ---------------------------------------------------------------------------
# The property everything else rests on: the same input gives the same tokenizer
# ---------------------------------------------------------------------------


def test_fitting_twice_gives_the_same_merges_and_the_same_digest():
    a, b = fitted(), fitted()
    assert a.merges == b.merges
    assert a.digest == b.digest
    assert len(a) == len(b)


def test_the_digest_covers_the_merge_order_not_only_the_set():
    """Swapping two merges changes what every later id means, so it must change the digest."""
    base = fitted(vocab_size=300)
    swapped = list(base.merges)
    swapped[10], swapped[11] = swapped[11], swapped[10]
    other = ByteBPETokenizer(merges=tuple(swapped))
    assert other.digest != base.digest


def test_a_tokenizer_round_trips_through_its_own_dict():
    original = fitted()
    restored = ByteBPETokenizer.from_dict(original.to_dict())
    assert restored.digest == original.digest
    assert restored.encode(CORPUS).tolist() == original.encode(CORPUS).tolist()
    with pytest.raises(ValueError, match="not a byte-BPE payload"):
        ByteBPETokenizer.from_dict({"kind": "character"})


def test_merges_that_refer_to_ids_that_do_not_exist_are_refused():
    with pytest.raises(ValueError, match="does not exist yet"):
        ByteBPETokenizer(merges=((256, 97),))  # 256 would be the merge's own id
    with pytest.raises(ValueError, match="appears twice"):
        ByteBPETokenizer(merges=((97, 98), (97, 98)))


# ---------------------------------------------------------------------------
# Encoding and decoding
# ---------------------------------------------------------------------------


def test_text_survives_a_round_trip_exactly():
    tokenizer = fitted()
    for text in [CORPUS, "def f(x):\n    return x + 1  # comment\n", "ünïcödé — em dash, 你好\n",
                 "tabs\tand  double  spaces\n\n\n"]:
        assert tokenizer.decode(tokenizer.encode(text)) == text


def test_every_byte_is_representable_so_there_are_no_unknown_tokens():
    """The claim that separates this from the character tokenizer, stated as a property."""
    tokenizer = fitted()
    arbitrary = bytes(range(256)).decode("latin-1")
    ids = tokenizer.encode(arbitrary)
    assert ids.min() >= 0 and ids.max() < tokenizer.size
    assert tokenizer.unknown_rate(arbitrary) == 0.0
    # Nothing was dropped: the ids cover every byte of the input.
    assert tokenizer.decode(ids) == arbitrary


def test_encoding_is_deterministic_and_returns_int32():
    tokenizer = fitted()
    first, second = tokenizer.encode(CORPUS), tokenizer.encode(CORPUS)
    assert first.dtype == np.int32
    assert first.tolist() == second.tolist()


def test_a_learned_vocabulary_is_smaller_than_the_characters_it_replaces():
    """The whole reason for the change: fewer tokens for the same text."""
    tokenizer = fitted(vocab_size=1000)
    characters = CharacterTokenizer.fit([CORPUS])
    assert len(tokenizer.encode(CORPUS)) < len(characters.encode(CORPUS)) / 2


def test_an_id_outside_the_vocabulary_is_refused_rather_than_guessed():
    tokenizer = fitted()
    for bad in (-1, tokenizer.size, tokenizer.size + 10):
        with pytest.raises(ValueError, match="outside the vocabulary"):
            tokenizer.decode([bad])
        with pytest.raises(ValueError, match="outside the vocabulary"):
            tokenizer.token_bytes(bad)


def test_the_vocabulary_size_is_the_base_alphabet_plus_the_merges():
    tokenizer = fitted(vocab_size=400)
    assert tokenizer.size == BASE_VOCAB_SIZE + len(tokenizer.merges)
    assert tokenizer.size <= 400, "the budget is a ceiling, not a target"


def test_no_merge_is_created_below_the_minimum_pair_count():
    """A pair seen once produces a token that generalises to nothing, so the loop stops first."""
    tokenizer = ByteBPETokenizer.fit([CORPUS * 40], vocab_size=100_000,
                                     sample_chars=len(CORPUS) * 40, min_pair_count=5)
    assert tokenizer.size < 100_000, "the run must stop before spending the whole budget"
    assert tokenizer.size > BASE_VOCAB_SIZE


# ---------------------------------------------------------------------------
# The sample
# ---------------------------------------------------------------------------


def test_the_sample_spreads_across_the_text_instead_of_taking_a_prefix():
    """A prefix is one source's idiom; the sample has to see the whole corpus.

    The corpus is a concatenation of files in sorted order, so the beginning is whichever
    source sorts first. `sample_evenly` is what stops the tokenizer being fitted on it.
    """
    # Fixed-width markers, so a slice boundary mid-marker cannot be misread as a smaller index.
    text = "".join(f"[{i:04d}]" for i in range(2000))
    sample = sample_evenly(text, 200, slices=8)
    assert 190 <= len(sample) <= 210
    seen = [int(m) for m in re.findall(r"\[(\d{4})\]", sample)]
    assert seen, "the sample contains no whole marker"
    assert min(seen) < 200, f"the sample does not start near the beginning: {seen[:3]}"
    assert max(seen) > 1600, f"the sample does not reach the end: {seen[-3:]}"
    # Spread, not just two clumps: the sample occupies at least five different tenths.
    assert len({m // 200 for m in seen}) >= 5, f"sample came from only {sorted({m // 200 for m in seen})}"


def test_a_short_text_is_returned_whole():
    assert sample_evenly("abc", 1000) == "abc"
    with pytest.raises(ValueError, match="must be positive"):
        sample_evenly("abc", 0)


def test_fitting_refuses_input_it_cannot_learn_from():
    with pytest.raises(ValueError, match="empty text"):
        ByteBPETokenizer.fit([""])
    with pytest.raises(ValueError, match="must exceed"):
        ByteBPETokenizer.fit(["some text"], vocab_size=BASE_VOCAB_SIZE)


def test_the_sample_choice_changes_the_vocabulary_which_is_why_it_is_recorded():
    """Two samples of the same corpus are two tokenizers; the digest is what tells them apart."""
    first = ByteBPETokenizer.fit([CORPUS * 40], vocab_size=600, sample_chars=400, min_pair_count=2)
    second = ByteBPETokenizer.fit([CORPUS * 40], vocab_size=600, sample_chars=len(CORPUS) * 40,
                                  min_pair_count=2)
    assert first.digest != second.digest
    # And each is still internally consistent: this is not a claim that either is "wrong".
    assert first.decode(first.encode(CORPUS)) == CORPUS


# ---------------------------------------------------------------------------
# The leak the character tokenizer's docstring warns about
# ---------------------------------------------------------------------------


def test_fitting_on_training_text_alone_is_what_the_caller_controls():
    """`fit` reads only what it is given, so a caller can hold out a source.

    This is asserted here rather than trusted because the failure is silent: fitting on
    validation text changes the vocabulary slightly, and nothing downstream would say so.
    """
    train = "alpha beta gamma delta " * 50
    validation = "zulu yankee xray whiskey " * 50
    tokenizer = ByteBPETokenizer.fit([train], vocab_size=400, sample_chars=len(train),
                                     min_pair_count=2)
    # The validation text encodes without error -- byte-level BPE always can -- but it uses
    # merges learned from training text, and the two vocabularies are not the same tokenizer.
    leaked = ByteBPETokenizer.fit([train + validation], vocab_size=400,
                                  sample_chars=len(train + validation), min_pair_count=2)
    assert tokenizer.digest != leaked.digest, "adding validation text must change the vocabulary"
    assert tokenizer.decode(tokenizer.encode(validation)) == validation
