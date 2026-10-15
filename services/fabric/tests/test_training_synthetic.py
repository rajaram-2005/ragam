"""The synthetic starter dataset: labelled, deterministic, disjoint, and its answers are right."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from fabric.training import synthetic
from fabric.training.jobspec import MIN_VALIDATION_EXAMPLES

REPO = Path(__file__).resolve().parent.parent
TEMPLATE = REPO / "remote" / "jobs" / "klyvaron-chat-lora-experiment.json"


def _parts(row: dict) -> tuple[str, str]:
    text = row["text"]
    assert text.startswith(synthetic.INSTRUCTION_MARKER)
    instruction, response = text[len(synthetic.INSTRUCTION_MARKER):].split(synthetic.RESPONSE_MARKER)
    return instruction.rsplit("\n\n", 1)[0], response


def test_two_builds_are_byte_identical():
    first = {name: synthetic.encode(rows) for name, rows in synthetic.build_splits().items()}
    second = {name: synthetic.encode(rows) for name, rows in synthetic.build_splits().items()}
    assert first == second


def test_every_row_is_labelled_synthetic_and_declares_its_family():
    for split, rows in synthetic.build_splits().items():
        assert len(rows) == synthetic.SPLIT_SIZES[split]
        for row in rows:
            assert row["synthetic"] is True
            assert "SYNTHETIC" in row["label"]
            assert set(row) == {"id", "family", "label", "synthetic", "text"}


def test_the_answers_are_computed_correctly():
    """If this fails, a generated answer is wrong, and training would teach a wrong fact."""
    checked = 0
    for row in synthetic.build_splits()["train"]:
        instruction, response = _parts(row)
        family = row["family"]
        if family == "addition":
            a, b = map(int, re.findall(r"\d+", instruction))
            assert response == f"{a} plus {b} is {a + b}."
        elif family == "reverse_words":
            words = instruction.split(": ", 1)[1].rstrip(".").split()
            assert response == f"The reversed order is: {' '.join(reversed(words))}."
        elif family == "letter_count":
            word = instruction.rsplit(" ", 1)[1].rstrip("?")
            assert response == f"The word {word} has {len(word)} letters."
        elif family == "uppercase":
            word = instruction.split()[3]
            assert response == word.upper()
        elif family == "vowel_count":
            word = instruction.rsplit(" ", 1)[1].rstrip("?")
            assert response == f"The word {word} has {sum(c in 'aeiou' for c in word)} vowels."
        elif family == "sort_numbers":
            numbers = [int(x) for x in re.findall(r"\d+", instruction)]
            assert response == ", ".join(map(str, sorted(numbers))) + "."
        else:
            raise AssertionError(f"unexpected training family {family!r}")
        checked += 1
    assert checked == synthetic.SPLIT_SIZES["train"]


def test_splits_share_no_text():
    splits = synthetic.build_splits()
    train = {row["text"] for row in splits["train"]}
    assert not any(row["text"] in train for row in splits["validation"])
    assert not any(row["text"] in train for row in splits["synthetic-regression"])


def test_the_regression_family_never_appears_in_training():
    splits = synthetic.build_splits()
    assert {row["family"] for row in splits["synthetic-regression"]} == {"colour_facts"}
    assert "colour_facts" not in {row["family"] for row in splits["train"]}


def test_validation_is_large_enough_for_the_acceptance_gate():
    assert synthetic.SPLIT_SIZES["validation"] >= MIN_VALIDATION_EXAMPLES


def test_the_manifest_hashes_the_files_it_wrote(tmp_path):
    manifest = synthetic.write_dataset(tmp_path)
    assert "SYNTHETIC" in manifest["label"]
    for split, entry in manifest["files"].items():
        data = (tmp_path / entry["file"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"]
        assert len(data) == entry["bytes"]
        assert entry["examples"] == synthetic.SPLIT_SIZES[split]
    on_disk = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert on_disk["digest"] == manifest["digest"]


def test_the_job_template_pins_exactly_what_the_generator_produces():
    """Drift guard: change the generator and this fails until the job's pins are updated too."""
    job = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    pins = synthetic.pins()
    assert job["dataset"]["train"]["sha256"] == pins["train"]["sha256"]
    assert job["dataset"]["validation"]["sha256"] == pins["validation"]["sha256"]
    assert job["dataset"]["regression"][0]["sha256"] == pins["synthetic-regression"]["sha256"]
    assert job["dataset"]["train"]["examples"] == pins["train"]["examples"]
