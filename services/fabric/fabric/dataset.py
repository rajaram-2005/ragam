"""Training and evaluation data for the Aetheris Lite retriever.

This module generates the corpus, the queries, the relevance judgements and the
BM25-mined hard negatives locally and deterministically from a seed.

Why synthetic data
------------------
No public retrieval dataset can be downloaded on this host, and a private
company corpus is not available to ship in a repository. So the corpus here is a
generated engineering-documentation fixture. That is stated plainly wherever the
results are reported: it demonstrates that the *mechanism* learns and can be
measured, and it is **not** evidence of quality on any real corpus. A production
run points ``build_dataset`` at real documents instead; nothing else changes.

The construction matters for the comparison to be fair
------------------------------------------------------
Each topic has two disjoint vocabularies: the words its *documents* use and the
words its *queries* use. A query therefore shares its concept with the right
document while sharing few literal terms with it. That is the situation dense
retrieval exists for, and it is also the situation BM25 handles worst — so BM25
is not being fed a corpus designed to make it lose. On the lexical-overlap subset
(``build_dataset(..., overlap="high")``) the two vocabularies coincide and BM25
is expected to win; that condition is evaluated too, and reported either way.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

import numpy as np

from .bm25 import Bm25Index
from .text import stem_tokens

__all__ = ["Topic", "Document", "Query", "RetrievalDataset", "build_dataset", "mine_hard_negatives"]


@dataclass(frozen=True)
class Topic:
    """One retrievable concept, with separate document and query vocabularies."""

    key: str
    label: str
    #: Terms documents use.
    doc_terms: tuple[str, ...]
    #: Terms queries use — deliberately different wording for the same concept.
    query_terms: tuple[str, ...]
    #: A concrete fact, so documents are not just bags of keywords.
    fact: str
    #: Numeric detail; gives BM25 something real to match on.
    values: tuple[str, ...]


@dataclass
class Document:
    doc_id: str
    text: str
    topic: str

    def to_dict(self) -> dict:
        return {"id": self.doc_id, "text": self.text, "topic": self.topic}


@dataclass
class Query:
    query_id: str
    text: str
    relevant: list[str]
    topic: str
    split: str = "train"

    def to_dict(self) -> dict:
        return {"id": self.query_id, "text": self.text, "relevant": self.relevant, "topic": self.topic, "split": self.split}


# --- the corpus -------------------------------------------------------------
# 24 engineering topics. `doc_terms` and `query_terms` are paraphrases of one
# another: the concept matches, the literal words largely do not.
TOPICS: tuple[Topic, ...] = (
    Topic("contactor", "contactor opening time", ("contactor", "open", "milliseconds", "pack", "relay"),
          ("disconnect", "response", "delay", "switch", "speed"),
          "The pack contactor must open within 250 milliseconds of an over-temperature trip.", ("250", "milliseconds")),
    Topic("isolation", "isolation resistance", ("isolation", "resistance", "ohm", "volt", "chassis"),
          ("leakage", "impedance", "insulation", "measurement", "body"),
          "Isolation resistance must remain above 500 ohms per volt at all times.", ("500", "ohms")),
    Topic("thermal", "thermal runaway threshold", ("thermal", "runaway", "celsius", "cell", "temperature"),
          ("overheating", "heat", "degrees", "escaping", "warmth"),
          "A cell above 68 degrees Celsius triggers the thermal runaway containment sequence.", ("68", "celsius")),
    Topic("balancing", "cell balancing", ("balancing", "bleed", "cell", "voltage", "equalize"),
          ("evening", "matching", "drain", "level", "uniform"),
          "Passive balancing bleeds the highest cell until the spread is under 20 millivolts.", ("20", "millivolts")),
    Topic("soc", "state of charge estimation", ("state", "charge", "coulomb", "counting", "estimate"),
          ("remaining", "capacity", "percentage", "gauge", "fuel"),
          "State of charge fuses coulomb counting with an open-circuit voltage correction.", ("95", "percent")),
    Topic("soh", "state of health", ("health", "degradation", "cycle", "fade", "aging"),
          ("wear", "lifetime", "condition", "deterioration", "endurance"),
          "Capacity fade below 80 percent of rated marks end of service life.", ("80", "percent")),
    Topic("precharge", "precharge circuit", ("precharge", "resistor", "inrush", "bus", "close"),
          ("softstart", "limiter", "surge", "ramp", "energize"),
          "The precharge resistor limits inrush current until the bus reaches 90 percent.", ("90", "percent", "470")),
    Topic("fuse", "main fuse rating", ("fuse", "rating", "amperes", "blow", "protect"),
          ("breaker", "current", "limit", "trip", "safeguard"),
          "The main fuse is rated at 400 amperes and clears a bolted fault in 10 milliseconds.", ("400", "amperes")),
    Topic("canbus", "CAN bus arbitration", ("can", "bus", "arbitration", "identifier", "bitrate"),
          ("network", "message", "priority", "wiring", "traffic"),
          "CAN arbitration resolves contention by identifier at a 500 kilobit rate.", ("500", "kilobit")),
    Topic("coolant", "coolant flow rate", ("coolant", "flow", "pump", "litres", "radiator"),
          ("liquid", "circulation", "rate", "gallons", "cooling"),
          "Coolant flow must stay above 12 litres per minute at full pump speed.", ("12", "litres")),
    Topic("torque", "motor torque limit", ("torque", "newton", "metre", "derate", "shaft"),
          ("twisting", "force", "output", "throttle", "power"),
          "Motor torque is derated to 180 newton metres above 45 degrees winding temperature.", ("180", "newton")),
    Topic("inverter", "inverter switching", ("inverter", "switching", "frequency", "igbt", "pwm"),
          ("converter", "chopping", "rate", "transistor", "modulation"),
          "Inverter switching frequency is fixed at 10 kilohertz above half load.", ("10", "kilohertz")),
    Topic("regen", "regenerative braking", ("regenerative", "braking", "recover", "energy", "charge"),
          ("recuperation", "slowing", "harvest", "feed", "back"),
          "Regenerative braking is disabled below 15 percent state of charge.", ("15", "percent")),
    Topic("firmware", "firmware update", ("firmware", "update", "flash", "bootloader", "image"),
          ("software", "upgrade", "install", "loader", "version"),
          "The bootloader rejects a firmware image whose signature does not verify.", ("2", "slots")),
    Topic("logging", "diagnostic logging", ("logging", "diagnostic", "buffer", "trace", "record"),
          ("journaling", "debug", "history", "capture", "audit"),
          "The diagnostic buffer retains the last 500 events across a power cycle.", ("500", "events")),
    Topic("watchdog", "watchdog timer", ("watchdog", "timer", "reset", "heartbeat", "expire"),
          ("supervisor", "clock", "restart", "pulse", "timeout"),
          "The watchdog forces a reset if no heartbeat arrives within 100 milliseconds.", ("100", "milliseconds")),
    Topic("emc", "electromagnetic compatibility", ("emission", "immunity", "shielding", "radiated", "conducted"),
          ("interference", "noise", "screening", "coupling", "disturbance"),
          "Radiated emissions must stay under the class B limit from 30 to 1000 megahertz.", ("30", "1000")),
    Topic("connector", "connector sealing", ("connector", "seal", "ingress", "mating", "gasket"),
          ("plug", "waterproof", "coupling", "join", "leak"),
          "Every high-voltage connector carries an ingress protection rating of IP67.", ("67", "ip")),
    Topic("sensor", "temperature sensor placement", ("sensor", "placement", "thermistor", "probe", "mount"),
          ("detector", "position", "reading", "element", "site"),
          "Two thermistors are mounted per module, on the busbar and the end plate.", ("2", "thermistors")),
    Topic("calibration", "sensor calibration", ("calibration", "offset", "gain", "reference", "trim"),
          ("adjustment", "tuning", "bias", "standard", "correction"),
          "Calibration stores a per-channel offset and gain against a 2.5 volt reference.", ("2.5", "volts")),
    Topic("redundancy", "redundant sensing", ("redundant", "dual", "channel", "diverse", "vote"),
          ("backup", "twofold", "path", "alternate", "majority"),
          "Brake sensing uses two diverse channels and a majority vote on disagreement.", ("2", "channels")),
    Topic("storage", "battery storage limits", ("storage", "limit", "humidity", "shelf", "warehouse"),
          ("keeping", "bound", "moisture", "inventory", "holding"),
          "Long-term storage requires 40 percent charge and below 60 percent humidity.", ("40", "60")),
    Topic("transport", "battery transport class", ("transport", "class", "shipping", "dangerous", "crate"),
          ("carriage", "category", "freight", "hazardous", "container"),
          "Transport falls under UN3480 and requires a class 9 hazard label.", ("3480", "class")),
    Topic("disposal", "end of life recycling", ("recycling", "recovery", "shred", "material", "reclaim"),
          ("disposal", "reprocessing", "salvage", "scrap", "renew"),
          "Recovered black mass yields at least 92 percent of its nickel content.", ("92", "percent")),
)

# A pool of filler sentences so documents are not bare keyword lists. This gives
# BM25 realistic noise to work against.
FILLER = (
    "This requirement applies to every variant produced after the revision date.",
    "Verification is performed during type testing and again at line end.",
    "The responsible engineer records the result in the vehicle test log.",
    "Deviation requires written approval from the systems lead.",
    "Related wiring diagrams are maintained in the harness specification.",
    "Field reports are reviewed quarterly against this criterion.",
)


def _document_text(topic: Topic, index: int, *, overlap: str) -> str:
    """Compose one document. ``overlap='high'`` lets query terms leak in."""
    terms = list(topic.doc_terms)
    if overlap == "high":
        # Lexically easy condition: documents reuse the query wording too.
        terms = terms + list(topic.query_terms[:3])
    lead = " ".join(terms[: min(len(terms), 3 + (index % 2))])
    value = topic.values[index % len(topic.values)]
    filler = FILLER[(index * 3 + len(topic.key)) % len(FILLER)]
    return f"{topic.label}: {topic.fact} Reference value {value}. {lead}. {filler}"


#: Fraction of queries that name a word from the topic label.
#:
#: Real users do this constantly: they paraphrase the requirement but still say
#: "contactor" or "thermal". Setting it to zero would remove every lexical signal
#: from the corpus and hand the dense retriever a baseline that scores exactly 0.0
#: on every metric — a rigged comparison that proves nothing. With half the queries
#: naming the topic, BM25 wins those and loses the pure paraphrases, which is the
#: real distribution the model has to improve on.
LABELLED_QUERY_EVERY = 2


def _label_word(topic: Topic, index: int) -> str:
    """A content word from the topic label, used verbatim by both sides."""
    words = [word for word in topic.label.split() if len(word) > 3]
    return words[index % len(words)] if words else topic.key


def _query_text(topic: Topic, index: int, *, overlap: str) -> str:
    terms = list(topic.query_terms)
    if overlap == "high":
        # Lexically easy condition: the query reuses document wording directly.
        terms = terms[:2] + list(topic.doc_terms[:3])
    rotation = index % len(terms)
    ordered = terms[rotation:] + terms[:rotation]
    phrasing = [
        "what is the requirement for {a} and {b}",
        "where is {a} with {b} specified",
        "explain {a} including {b}",
        "which document covers {a} or {b}",
    ][index % 4]
    text = phrasing.format(a=ordered[0], b=ordered[1] if len(ordered) > 1 else ordered[0])
    if overlap == "high" or index % LABELLED_QUERY_EVERY == 0:
        text = f"{text} regarding {_label_word(topic, index)}"
    return text


@dataclass
class RetrievalDataset:
    """A corpus with judged queries, split into development and evaluation."""

    documents: list[Document]
    queries: list[Query]
    overlap: str
    seed: int
    meta: dict = field(default_factory=dict)

    @property
    def train_queries(self) -> list[Query]:
        return [query for query in self.queries if query.split == "train"]

    @property
    def evaluation_queries(self) -> list[Query]:
        return [query for query in self.queries if query.split == "evaluation"]

    def index(self) -> Bm25Index:
        """Build the BM25 baseline over this corpus."""
        bm25 = Bm25Index()
        for document in self.documents:
            bm25.add(document.doc_id, document.text, {"topic": document.topic})
        return bm25

    def triples(self, queries: list[Query] | None = None) -> list[tuple[str, str, str]]:
        """(query, positive, hard-negative) triples with BM25-mined negatives."""
        targets = queries if queries is not None else self.train_queries
        bm25 = self.index()
        by_id = {document.doc_id: document for document in self.documents}
        out: list[tuple[str, str, str]] = []
        for query in targets:
            for relevant in query.relevant:
                positive = by_id[relevant].text
                negative = mine_hard_negatives(bm25, query.text, relevant_ids=set(query.relevant), count=1)
                negative_text = by_id[negative[0]].text if negative else positive
                out.append((query.text, positive, negative_text))
        return out

    def to_dict(self) -> dict:
        return {
            "documents": [document.to_dict() for document in self.documents],
            "queries": [query.to_dict() for query in self.queries],
            "overlap": self.overlap,
            "seed": self.seed,
            "meta": self.meta,
        }

    def digest(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


def mine_hard_negatives(index: Bm25Index, query: str, *, relevant_ids: set[str], count: int = 5) -> list[str]:
    """Top BM25 hits that are NOT relevant — the hardest lexical confusions.

    Mining negatives from the baseline is what makes the trained model beat it for
    a real reason: it learns specifically to separate the documents BM25 confuses.
    """
    hits = index.search(query, top_k=max(20, count * 6))
    negatives = [hit["docId"] for hit in hits if hit["docId"] not in relevant_ids]
    return negatives[:count]


def build_dataset(
    *,
    seed: int = 0,
    overlap: str = "low",
    split_by: str = "query",
    documents_per_topic: int = 4,
    queries_per_topic: int = 3,
    evaluation_fraction: float = 0.25,
    topics: tuple[Topic, ...] = TOPICS,
) -> RetrievalDataset:
    """Generate a deterministic retrieval dataset.

    ``overlap``
        ``'low'``  documents and queries use largely disjoint wording — the hard,
                   realistic condition for lexical retrieval.
        ``'high'`` they share wording — the easy condition, where BM25 is expected
                   to win and a dense model has no advantage to find.

    ``split_by`` — what is held out, and why it matters
        ``'query'`` (default) holds out *queries* while every document stays in the
        index for both splits. This is the deployment condition: a retriever is
        always fitted to a corpus that already exists, and what has to generalise
        is unseen question phrasing over known documents.

        ``'topic'`` additionally holds out whole topics — their documents *and*
        their queries. This is a much harder test and on this corpus it is close to
        ill-posed: the generated topics use almost disjoint vocabularies (about 21%
        term overlap, and the shared terms are non-discriminative filler), so a
        model fitted to 54 triples has no shared substructure to generalise
        through. Measured honestly, the dense retriever scores far below BM25 under
        this split. That result is recorded in ``docs/06-benchmarks.md`` as a real
        limitation rather than hidden by choosing the flattering split.

    Queries within a topic are split by index, so a topic appearing in both splits
    never contributes the *same* question to both.
    """
    if overlap not in ("low", "high"):
        raise ValueError("overlap must be 'low' or 'high'")
    if split_by not in ("query", "topic"):
        raise ValueError("split_by must be 'query' or 'topic'")
    if documents_per_topic < 1 or queries_per_topic < 1:
        raise ValueError("documents_per_topic and queries_per_topic must be positive")
    if not 0.0 < evaluation_fraction < 1.0:
        raise ValueError("evaluation_fraction must be within (0, 1)")

    rng = np.random.default_rng(seed)
    documents: list[Document] = []
    queries: list[Query] = []

    for topic in topics:
        for index in range(documents_per_topic):
            documents.append(
                Document(
                    doc_id=f"{topic.key}-d{index}",
                    text=_document_text(topic, index, overlap=overlap),
                    topic=topic.key,
                )
            )
        for index in range(queries_per_topic):
            queries.append(
                Query(
                    query_id=f"{topic.key}-q{index}",
                    text=_query_text(topic, index, overlap=overlap),
                    # The first document of the topic is the judged answer; the
                    # others are topically related but not judged relevant, so a
                    # retriever cannot score well by returning the whole topic.
                    relevant=[f"{topic.key}-d0"],
                    topic=topic.key,
                )
            )

    keys = [topic.key for topic in topics]
    evaluation_topics: set[str] = set()

    if split_by == "topic":
        order = rng.permutation(len(keys))
        cut = max(1, int(round(len(keys) * evaluation_fraction)))
        evaluation_topics = {keys[i] for i in order[:cut]}
        for query in queries:
            query.split = "evaluation" if query.topic in evaluation_topics else "train"
    else:
        # Hold out a fraction of each topic's queries. Every document stays in the
        # index, exactly as it would in a deployed system.
        #
        # Which queries are held out is chosen at random per topic. Taking them in
        # index order instead would be a subtle bias: query index 0 is always one of
        # the "labelled" phrasings that names the topic, so an order-based split
        # hands the evaluation set to exactly the queries BM25 handles best and
        # makes the two overlap conditions indistinguishable.
        by_topic: dict[str, list[Query]] = {}
        for query in queries:
            by_topic.setdefault(query.topic, []).append(query)
        for topic_key in keys:
            group = by_topic.get(topic_key)
            if not group:
                continue
            held = max(1, int(round(len(group) * evaluation_fraction)))
            held = min(held, len(group) - 1) if len(group) > 1 else len(group)
            chosen = set(rng.permutation(len(group))[:held].tolist())
            for position, query in enumerate(group):
                query.split = "evaluation" if position in chosen else "train"
        if not any(q.split == "evaluation" for q in queries):
            raise ValueError("the split produced no evaluation queries")
        if not any(q.split == "train" for q in queries):
            raise ValueError("the split produced no training queries")

    # Record what was actually achieved, since integer granularity means the
    # realised fraction differs from the requested one.
    total_queries = len(queries)
    evaluation_count = sum(1 for q in queries if q.split == "evaluation")
    realised_fraction = evaluation_count / total_queries if total_queries else 0.0

    return RetrievalDataset(
        documents=documents,
        queries=queries,
        overlap=overlap,
        seed=seed,
        meta={
            "topics": len(topics),
            "documentsPerTopic": documents_per_topic,
            "queriesPerTopic": queries_per_topic,
            "evaluationFraction": evaluation_fraction,
            "evaluationTopics": sorted(evaluation_topics),
            "splitBy": split_by,
            "evaluationQueries": evaluation_count,
            "trainQueries": total_queries - evaluation_count,
            "realisedEvaluationFraction": round(realised_fraction, 4),
            #: Whether the held-out queries systematically favour one phrasing.
            "evaluationLabelledFraction": round(
                sum(1 for q in queries if q.split == "evaluation" and "regarding" in q.text) / max(evaluation_count, 1), 4
            ),
            "trainLabelledFraction": round(
                sum(1 for q in queries if q.split == "train" and "regarding" in q.text)
                / max(total_queries - evaluation_count, 1), 4
            ),
            "generated": True,
            "note": "synthetic engineering-documentation fixture; not a real corpus",
        },
    )
