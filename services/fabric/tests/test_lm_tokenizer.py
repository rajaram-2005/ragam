"""Character tokenizer: determinism, round-tripping, and honest unknown handling."""

from __future__ import annotations

import numpy as np
import pytest

from fabric.lm.tokenizer import CharacterTokenizer, UNK_CHAR, UNK_ID


def test_fitting_is_deterministic_and_sorted():
    texts = ["the quick brown fox", "jumps over the lazy dog"]
    a = CharacterTokenizer.fit(texts)
    b = CharacterTokenizer.fit(texts)
    assert a.characters == b.characters == tuple(sorted(a.characters))
    assert a.digest == b.digest


def test_fitting_is_order_independent():
    """The vocabulary must not depend on which file was read first."""
    forward = CharacterTokenizer.fit(["abc", "def"])
    backward = CharacterTokenizer.fit(["def", "abc"])
    assert forward.characters == backward.characters
    assert forward.digest == backward.digest


def test_the_unknown_token_is_reserved_and_never_enters_the_vocabulary():
    assert UNK_ID == 0
    tokenizer = CharacterTokenizer.fit(["hello"])
    assert UNK_CHAR not in tokenizer.characters
    with pytest.raises(ValueError, match="reserved for the unknown token"):
        CharacterTokenizer(characters=(UNK_CHAR, "a"))


def test_unknown_characters_map_to_id_zero_and_are_counted():
    tokenizer = CharacterTokenizer.fit(["aaaa"])
    ids = tokenizer.encode("aZb")
    assert ids.tolist() == [1, 0, 0]  # 'a' present, 'Z' and 'b' are not
    assert tokenizer.unknown_rate("aZb") == pytest.approx(2 / 3)
    assert tokenizer.unknown_rate("aaa") == 0.0
    assert tokenizer.unknown_rate("") == 0.0


def test_encode_decode_round_trips_every_character():
    text = "the quick brown\nfox\tjumps over $100 & 42% <tag>"
    tokenizer = CharacterTokenizer.fit([text])
    assert tokenizer.decode(tokenizer.encode(text)) == text
    assert tokenizer.unknown_rate(text) == 0.0


def test_decode_refuses_an_id_outside_the_vocabulary():
    """Silently wrapping to another character would corrupt any generated sample."""
    tokenizer = CharacterTokenizer.fit(["abc"])
    with pytest.raises(ValueError, match="outside the vocabulary"):
        tokenizer.decode([tokenizer.size + 5])
    with pytest.raises(ValueError, match="outside the vocabulary"):
        tokenizer.decode([-1])


def test_the_vocabulary_round_trips_through_json():
    import json

    tokenizer = CharacterTokenizer.fit(["hello world"])
    restored = CharacterTokenizer.from_dict(json.loads(json.dumps(tokenizer.to_dict())))
    assert restored.characters == tokenizer.characters
    assert restored.digest == tokenizer.digest
    assert restored.decode(restored.encode("hello")) == "hello"


def test_a_foreign_payload_is_refused():
    with pytest.raises(ValueError, match="not a character tokenizer"):
        CharacterTokenizer.from_dict({"kind": "bpe", "characters": ["a"]})


def test_min_count_drops_rare_characters_and_reports_it():
    tokenizer = CharacterTokenizer.fit(["aaab"], min_count=2)
    assert tokenizer.characters == ("a",)
    assert tokenizer.decode(tokenizer.encode("b")) == UNK_CHAR


def test_empty_and_degenerate_fits_raise_rather_than_produce_a_broken_vocabulary():
    with pytest.raises(ValueError, match="empty text"):
        CharacterTokenizer.fit([])
    with pytest.raises(ValueError, match="removed every character"):
        CharacterTokenizer.fit(["a"], min_count=5)


def test_size_includes_the_unknown_token():
    tokenizer = CharacterTokenizer.fit(["abc"])
    assert tokenizer.size == 3 + 1
    assert len(tokenizer) == tokenizer.size


def test_encode_returns_the_declared_dtype():
    tokenizer = CharacterTokenizer.fit(["abc"])
    ids = tokenizer.encode("abcabc")
    assert ids.dtype == np.int32
    assert ids.shape == (6,)
