"""Data validation, quality scoring and dataset manifests.

Provenance
----------
The formula, the weights and the tier thresholds are adopted from
``sparsiz/training/dataforge/dataforge.py``::

    Q(x) = w1*Q_semantic + w2*Q_technical + w3*Q_novelty + w4*Q_source - w5*Q_risk
    BAD < 0.3 <= MEDIUM < 0.6 <= HIGH < 0.85 <= ELITE

The five terms are **not** adopted. Upstream computed every one of them with
``random.uniform`` (``dataforge.py:54-61``), so a sample's quality score changed
each time it was scored and could not be reproduced. Here each term is a
deterministic measurement of the sample itself:

===============  ==========================================================
``q_semantic``   length adequacy, sentence structure, and (for QA samples)
                 whether the answer actually addresses the question
``q_technical``  density of technical markers: numerals, units, code
                 punctuation, identifiers, domain vocabulary
``q_novelty``    1 - the largest token-set overlap with samples already
                 accepted into the same manifest
``q_source``     an explicit, declared trust table — a policy decision that is
                 written down, not a dice roll
``q_risk``       credential/PII pattern hits and unsafe-content markers
===============  ==========================================================

Upstream also truncated the content hash to 16 hex characters. That is 64 bits,
which is fine for casual dedupe but weak for a manifest that is meant to prove
what was trained on, so full SHA-256 digests are used here.

``q_novelty`` is the one term that depends on something other than the sample:
it is measured against the samples already in the manifest. Scoring is therefore
order-dependent *by design* — the same batch scored in the same order gives the
same result, and ``DatasetManifest.add`` is the only entry point that mutates
that state.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence

from .records import RecordMixin
from .taxonomy import DataQualityTier
from .text import STOPWORDS, content_tokens, stem_tokens

__all__ = [
    "DataSample",
    "QualityWeights",
    "QualityEngine",
    "DatasetManifest",
    "ContaminationReport",
    "SOURCE_TRUST",
    "check_contamination",
]


# --- risk patterns ---------------------------------------------------------
# Mirrors services/core/src/policy/classify.mjs. The same credential shapes must
# be treated as risky on both sides of the platform, or data accepted as clean by
# Fabric could be redacted as restricted by the core service.
RISK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("openai_style_key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("aws_access_key_id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("private_key_block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("connection_string", re.compile(r"\b(?:postgres|postgresql|mysql|mongodb|redis|amqp)://[^\s'\"]+:[^\s'\"]+@[^\s'\"]+")),
    ("url_basic_auth", re.compile(r"\bhttps?://[^\s/:@'\"]+:[^\s@'\"]+@[^\s'\"/]+")),
    # '_' is a word character, so \bsecret\b cannot match inside AWS_SECRET_ACCESS_KEY.
    ("env_style_secret", re.compile(
        r"(?:^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)"
        r"[A-Z0-9_]*\s*[:=]\s*['\"]?[^\s'\";,}]{8,}"
    )),
    ("email_address", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("long_digit_run", re.compile(r"\b\d{9,}\b")),
)

#: Credential material, not merely a document that mentions a secret.
RESTRICTED_RISK = frozenset({"private_key_block", "aws_access_key_id", "env_style_secret", "url_basic_auth", "connection_string"})

UNSAFE_MARKERS = ("exploit", "malware", "keylogger", "ransomware", "weaponize", "do not distribute")

#: Declared source trust. An explicit policy table: adding a source is a decision
#: someone makes and commits, not a probability.
SOURCE_TRUST: Mapping[str, float] = {
    "textbook": 0.95,
    "arxiv": 0.9,
    "specification": 0.9,
    "company-documentation": 0.9,
    "github": 0.8,
    "wikipedia": 0.75,
    "internal-wiki": 0.85,
    "vendor-datasheet": 0.85,
    "web": 0.5,
    "forum": 0.4,
    "social": 0.25,
    "unknown": 0.3,
    "synthetic": 0.55,
}

TECHNICAL_MARKERS = (
    re.compile(r"\d"),                                    # numerals
    re.compile(r"\b(?:mm|ms|ohm|volt|amp|celsius|hz|gb|mb|kb|nm|w|v|a|k)\b", re.I),  # units
    re.compile(r"[{}()\[\];=<>_/\|&*+#@]"),               # code / schematic punctuation
    re.compile(r"\b[a-z]+_[a-z_]+\b"),                    # snake_case identifiers
    re.compile(r"\b[A-Z]{2,}\b"),                         # uppercase acronyms
)

DOMAIN_TERMS = frozenset({
    "contactor", "cell", "pack", "thermal", "isolation", "resistance", "voltage",
    "current", "threshold", "busbar", "inverter", "bms", "firmware", "torque",
    "latency", "throughput", "quantization", "gradient", "embedding", "retrieval",
})


@dataclass
class DataSample:
    """One training or evaluation sample."""

    content: str
    modality: str = "text"
    source: str = "unknown"
    #: For QA samples, ``{"query": ..., "answer": ..., "relevant": [...]}``.
    fields: dict = field(default_factory=dict)
    metadata: dict = field(default_factory=dict)
    sample_id: str | None = None
    sha256: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.content, str):
            raise TypeError("content must be a string")
        if self.sha256 is None:
            self.sha256 = hashlib.sha256(self.content.encode("utf-8")).hexdigest()
        if self.sample_id is None:
            self.sample_id = self.sha256[:16]

    def to_dict(self) -> dict:
        return {
            "id": self.sample_id,
            "sha256": self.sha256,
            "modality": self.modality,
            "source": self.source,
            "chars": len(self.content),
            "fields": self.fields,
            "metadata": self.metadata,
        }


@dataclass
class QualityWeights:
    """Upstream defaults, unchanged."""

    w_semantic: float = 0.30
    w_technical: float = 0.25
    w_novelty: float = 0.20
    w_source: float = 0.15
    w_risk: float = 0.10

    def as_dict(self) -> dict:
        return {
            "w_semantic": self.w_semantic,
            "w_technical": self.w_technical,
            "w_novelty": self.w_novelty,
            "w_source": self.w_source,
            "w_risk": self.w_risk,
        }


class QualityEngine:
    """Deterministic Q(x) scoring."""

    def __init__(self, weights: QualityWeights | None = None, source_trust: Mapping[str, float] | None = None) -> None:
        self.weights = weights or QualityWeights()
        self.source_trust = dict(source_trust or SOURCE_TRUST)

    # --- individual terms -------------------------------------------------

    def q_semantic(self, sample: DataSample) -> float:
        """Length adequacy, sentence structure, and QA coherence."""
        text = sample.content.strip()
        if not text:
            return 0.0
        length = len(text)
        # Too short to carry meaning, too long to be a single coherent sample.
        if length < 40:
            length_score = length / 40 * 0.5
        elif length <= 2000:
            length_score = 1.0
        else:
            length_score = max(0.4, 1.0 - (length - 2000) / 8000)

        sentences = [part for part in re.split(r"[.!?;\n]+", text) if part.strip()]
        structure = min(1.0, len(sentences) / 3) if sentences else 0.0
        # A sample with sentence-final punctuation is prose; a bare fragment is not.
        punctuation = 1.0 if re.search(r"[.!?]\s*$", text) else 0.6

        coherence = 1.0
        query = sample.fields.get("query")
        answer = sample.fields.get("answer")
        if query and answer:
            overlap = self._token_overlap(str(query), str(answer))
            # An answer that shares no term at all with its question is suspicious,
            # but total overlap means the answer merely echoes the question.
            coherence = min(1.0, overlap / 0.15) if overlap < 0.15 else (1.0 if overlap <= 0.8 else 0.7)
        elif query or answer:
            coherence = 0.7  # a half-populated QA pair

        return round(0.45 * length_score + 0.2 * structure + 0.15 * punctuation + 0.2 * coherence, 6)

    def q_technical(self, sample: DataSample) -> float:
        """Density of technical markers and domain vocabulary."""
        text = sample.content
        tokens = content_tokens(text) or [""]
        markers = sum(1 for pattern in TECHNICAL_MARKERS if pattern.search(text))
        marker_score = markers / len(TECHNICAL_MARKERS)

        lowered = {token.lower() for token in tokens}
        domain_hits = len(lowered & DOMAIN_TERMS)
        domain_score = min(1.0, domain_hits / 4)

        # Declared modality is a real signal: code and maths samples are technical
        # by construction. This replaces upstream's flat 0.9 for those modalities
        # with something that still rewards them but verifies it.
        declared = 0.9 if sample.modality in {"code", "math", "physics", "engineering"} else 0.4
        return round(0.4 * marker_score + 0.35 * domain_score + 0.25 * declared, 6)

    def q_source(self, sample: DataSample) -> float:
        """Trust of the declared source, from the explicit table."""
        key = str(sample.source or "unknown").strip().lower()
        if key in self.source_trust:
            return self.source_trust[key]
        # A substring match lets "arxiv:2401.12345" resolve to "arxiv".
        for name, score in self.source_trust.items():
            if name in key:
                return score
        return self.source_trust["unknown"]

    def q_risk(self, sample: DataSample) -> float:
        """Credential/PII exposure plus unsafe-content markers. Higher is worse."""
        text = sample.content
        hits = [name for name, pattern in RISK_PATTERNS if pattern.search(text)]
        lowered = text.lower()
        unsafe = [marker for marker in UNSAFE_MARKERS if marker in lowered]

        score = 0.0
        score += 0.35 * min(1.0, len(hits) / 2)
        if any(hit in RESTRICTED_RISK for hit in hits):
            score += 0.4
        score += 0.25 * min(1.0, len(unsafe) / 2)
        if sample.metadata.get("safety") == "unsafe":
            score += 0.2
        return round(min(1.0, score), 6)

    def q_novelty(self, sample: DataSample, seen: Iterable[set[str]] = ()) -> float:
        """1 - the largest token-set overlap with samples already accepted."""
        tokens = set(stem_tokens(sample.content))
        if not tokens:
            return 0.0
        worst = 0.0
        for previous in seen:
            if not previous:
                continue
            union = len(tokens | previous)
            if union == 0:
                continue
            overlap = len(tokens & previous) / union
            if overlap > worst:
                worst = overlap
                if worst >= 1.0:
                    break
        return round(1.0 - worst, 6)

    # --- aggregate --------------------------------------------------------

    def score(self, sample: DataSample, seen: Iterable[set[str]] = ()) -> tuple[float, DataQualityTier, dict]:
        """Return ``(q, tier, terms)`` for one sample."""
        terms = {
            "q_semantic": self.q_semantic(sample),
            "q_technical": self.q_technical(sample),
            "q_novelty": self.q_novelty(sample, seen),
            "q_source": self.q_source(sample),
            "q_risk": self.q_risk(sample),
        }
        weights = self.weights
        q = (
            weights.w_semantic * terms["q_semantic"]
            + weights.w_technical * terms["q_technical"]
            + weights.w_novelty * terms["q_novelty"]
            + weights.w_source * terms["q_source"]
            - weights.w_risk * terms["q_risk"]
        )
        q = max(0.0, min(1.0, q))
        return round(q, 6), DataQualityTier.for_score(q), terms

    def risk_findings(self, sample: DataSample) -> list[str]:
        """Which risk patterns matched. Names only — never the matched values."""
        return [name for name, pattern in RISK_PATTERNS if pattern.search(sample.content)]

    @staticmethod
    def _token_overlap(left: str, right: str) -> float:
        a = set(stem_tokens(left)) - STOPWORDS
        b = set(stem_tokens(right)) - STOPWORDS
        if not a or not b:
            return 0.0
        return len(a & b) / len(a | b)


class ContaminationReport(RecordMixin):
    """Result of checking an evaluation split against a training split."""


def _shingles(tokens: Sequence[str], size: int = 5) -> set[tuple[str, ...]]:
    if len(tokens) < size:
        return {tuple(tokens)} if tokens else set()
    return {tuple(tokens[i : i + size]) for i in range(len(tokens) - size + 1)}


def check_contamination(
    train: Sequence[DataSample],
    evaluation: Sequence[DataSample],
    *,
    shingle_size: int = 5,
    threshold: float = 0.8,
) -> ContaminationReport:
    """Detect evaluation samples that leaked into training.

    Two checks, because exact-hash comparison alone is not enough: a sample
    reworded in one place still teaches the model the answer.

    1. **Exact** — matching SHA-256 of the content.
    2. **Near-duplicate** — the fraction of the evaluation sample's 5-token
       shingles that also appear in some training sample, above ``threshold``.

    The directive requires development and evaluation data to be kept separate
    and benchmark contamination to be checked; this is that check.
    """
    train_hashes = {sample.sha256 for sample in train}
    train_shingles: list[set] = [_shingles(stem_tokens(sample.content), shingle_size) for sample in train]

    exact: list[str] = []
    near: list[dict] = []

    for sample in evaluation:
        if sample.sha256 in train_hashes:
            exact.append(sample.sample_id or sample.sha256[:16])
            continue
        target = _shingles(stem_tokens(sample.content), shingle_size)
        if not target:
            continue
        best, best_index = 0.0, -1
        for index, previous in enumerate(train_shingles):
            if not previous:
                continue
            overlap = len(target & previous) / len(target)
            if overlap > best:
                best, best_index = overlap, index
        if best >= threshold:
            near.append(
                {
                    "evaluationId": sample.sample_id,
                    "trainingIndex": best_index,
                    "trainingId": train[best_index].sample_id if best_index >= 0 else None,
                    "shingleOverlap": round(best, 6),
                }
            )

    return ContaminationReport(
        contaminated=bool(exact or near),
        exactDuplicates=exact,
        nearDuplicates=near,
        trainSamples=len(train),
        evaluationSamples=len(evaluation),
        shingleSize=shingle_size,
        threshold=threshold,
    )


class DatasetManifest:
    """A scored, deduplicated, split dataset with a content hash.

    The manifest is what a run record points at. Two runs pointing at manifests
    with the same digest trained on the same data, which is what makes a
    comparison in the experiment ledger meaningful.
    """

    def __init__(self, *, engine: QualityEngine | None = None, min_tier: DataQualityTier = DataQualityTier.MEDIUM) -> None:
        self.engine = engine or QualityEngine()
        self.min_tier = min_tier
        self._order = ["bad", "medium", "high", "elite"]
        self.samples: list[dict] = []
        self.rejected: list[dict] = []
        self._by_hash: dict[str, dict] = {}
        self._token_sets: list[set[str]] = []

    def __len__(self) -> int:
        return len(self.samples)

    def add(self, sample: DataSample) -> dict:
        """Score and admit a sample. Returns the recorded entry.

        Duplicates (same content hash) are admitted once. Samples below
        ``min_tier`` are recorded in ``rejected`` with the reason, so a dataset
        can explain what it declined rather than silently dropping it.
        """
        if sample.sha256 in self._by_hash:
            existing = self._by_hash[sample.sha256]
            existing["duplicates"] = existing.get("duplicates", 0) + 1
            return existing

        q, tier, terms = self.engine.score(sample, seen=self._token_sets)
        entry = {
            **sample.to_dict(),
            "quality": q,
            "tier": tier.value,
            "terms": terms,
            "riskFindings": self.engine.risk_findings(sample),
            "duplicates": 0,
        }

        if self._tier_rank(tier) < self._tier_rank(self.min_tier):
            entry["rejected"] = f"quality tier {tier.value} is below the required {self.min_tier.value}"
            self.rejected.append(entry)
            return entry
        if entry["riskFindings"] and any(finding in RESTRICTED_RISK for finding in entry["riskFindings"]):
            entry["rejected"] = f"credential material present: {', '.join(entry['riskFindings'])}"
            self.rejected.append(entry)
            return entry

        self.samples.append(entry)
        self._by_hash[sample.sha256] = entry
        self._token_sets.append(set(stem_tokens(sample.content)))
        return entry

    def add_all(self, samples: Iterable[DataSample]) -> int:
        return sum(1 for sample in samples if self.add(sample).get("rejected") is None)

    def _tier_rank(self, tier: DataQualityTier) -> int:
        return self._order.index(tier.value)

    def tier_counts(self) -> dict[str, int]:
        counts = {name: 0 for name in self._order}
        for entry in self.samples:
            counts[entry["tier"]] += 1
        return counts

    def quality_summary(self) -> dict:
        qualities = [entry["quality"] for entry in self.samples]
        return {
            "accepted": len(self.samples),
            "rejected": len(self.rejected),
            "duplicates": sum(entry.get("duplicates", 0) for entry in self.samples),
            "tiers": self.tier_counts(),
            "meanQuality": round(sum(qualities) / len(qualities), 6) if qualities else 0.0,
            "minQuality": round(min(qualities), 6) if qualities else 0.0,
            "maxQuality": round(max(qualities), 6) if qualities else 0.0,
        }

    def split(self, *, evaluation_fraction: float = 0.2, seed: int = 0) -> dict[str, list[dict]]:
        """Deterministic split that keeps development and evaluation apart.

        Ordering is by content hash, not by insertion order, so the split does not
        depend on the order files happened to be read in. ``seed`` shifts the
        ordering for a genuinely different split without making it random.
        """
        if not 0.0 < evaluation_fraction < 1.0:
            raise ValueError("evaluation_fraction must be within (0, 1)")
        if len(self.samples) < 2:
            # A single sample cannot be both trained on and evaluated against.
            # Returning an empty evaluation split here would be worse than raising:
            # every metric computed from it would be vacuous, and an evaluation run
            # against the training split would look like a perfect score.
            raise ValueError(f"a split needs at least 2 samples, the manifest holds {len(self.samples)}")
        keyed = sorted(
            self.samples,
            key=lambda entry: (hashlib.sha256(f"{seed}:{entry['sha256']}".encode()).hexdigest(), entry["sha256"]),
        )
        cut = max(1, int(round(len(keyed) * evaluation_fraction)))
        evaluation, train = keyed[:cut], keyed[cut:]
        if not train:
            raise ValueError("the split leaves no training samples")
        if not evaluation:
            raise ValueError("the split leaves no evaluation samples")
        return {"train": train, "evaluation": evaluation}

    def digest(self) -> str:
        """Content hash of the manifest: the sample hashes, in order, plus weights."""
        payload = {
            "samples": [entry["sha256"] for entry in self.samples],
            "rejected": [entry["sha256"] for entry in self.rejected],
            "weights": self.engine.weights.as_dict(),
            "minTier": self.min_tier.value,
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def to_dict(self) -> dict:
        return {
            "digest": self.digest(),
            "summary": self.quality_summary(),
            "samples": self.samples,
            "rejected": self.rejected,
        }
