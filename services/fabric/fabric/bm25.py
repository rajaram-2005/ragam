"""BM25 — the baseline the Aetheris Lite retriever is measured against.

This is a faithful port of ``services/core/src/knowledge/bm25.mjs``, which is the
index that actually serves retrieval in production. Same defaults (k1=1.5,
b=0.75), same IDF, same accumulation order, same tie-breaking.

    idf(t)      = log(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
    score(D, Q) = sum over q in Q of  idf(q) * f(q,D)*(k1+1) / (f(q,D) + k1*(1 - b + b*|D|/avgdl))

Ties are broken by document id ascending, exactly as the Node ``localeCompare``
sort does for ASCII identifiers. That matters: without a deterministic
tie-break, two runs of the same benchmark can report different Recall@k and the
experiment ledger would record noise as signal.

Why BM25 is the right baseline here
-----------------------------------
It is the system being replaced, it needs no training data, and it is strong on
exactly the corpus in question (technical documents where the discriminating
terms are literal). If the trained retriever cannot beat it, it is not an
improvement, whatever its loss curve looks like.
"""

from __future__ import annotations

import math
from typing import Callable, Iterable

from .text import stem_tokens

__all__ = ["Bm25Index", "SearchHit", "round6"]


def round6(value: float) -> float:
    """Round to 6 decimals the way the Node implementation does.

    ``Math.round(x * 1e6) / 1e6`` rounds halves *up*, while Python's ``round()``
    rounds halves to even. The two disagree on exact halves, so the JS formula is
    reproduced rather than approximated — otherwise ``stats()`` can differ between
    the two implementations for the same corpus and the parity check would be
    testing the rounding mode instead of the retrieval maths.
    """
    number = float(value or 0.0)
    return math.floor(number * 1e6 + 0.5) / 1e6


class SearchHit(dict):
    """A search result. A dict subclass so it serialises to JSON directly."""

    @property
    def doc_id(self) -> str:
        return self["docId"]

    @property
    def score(self) -> float:
        return self["score"]


class Bm25Index:
    """Okapi BM25 over stemmed content tokens.

    In-memory and rebuildable: the authoritative chunk text lives in SQLite (in
    the core service) and this index can always be reconstructed from it, so it
    is never a source of truth and never needs durability.
    """

    def __init__(self, *, k1: float = 1.5, b: float = 0.75) -> None:
        if k1 <= 0:
            raise ValueError("k1 must be positive")
        if not 0.0 <= b <= 1.0:
            raise ValueError("b must be within [0, 1]")
        self.k1 = k1
        self.b = b
        self._docs: dict[str, dict] = {}
        self._postings: dict[str, dict[str, int]] = {}
        self._df: dict[str, int] = {}
        self._total_length = 0
        self.version = 1

    # --- collection state -------------------------------------------------

    def __len__(self) -> int:
        return len(self._docs)

    def __contains__(self, doc_id: object) -> bool:
        return doc_id in self._docs

    @property
    def size(self) -> int:
        return len(self._docs)

    @property
    def avgdl(self) -> float:
        return self._total_length / len(self._docs) if self._docs else 0.0

    def idf(self, term: str) -> float:
        n = self._df.get(term, 0)
        total = len(self._docs)
        return math.log(1 + (total - n + 0.5) / (n + 0.5))

    # --- mutation ---------------------------------------------------------

    def add(self, doc_id: str, text: str, meta: dict | None = None) -> dict:
        """Index or re-index a document. Idempotent per doc_id."""
        if not isinstance(doc_id, str) or not doc_id:
            raise ValueError("doc_id must be a non-empty string")
        if doc_id in self._docs:
            self.remove(doc_id)

        tokens = stem_tokens(text)
        freq: dict[str, int] = {}
        for token in tokens:
            freq[token] = freq.get(token, 0) + 1

        self._docs[doc_id] = {"tokens": tokens, "length": len(tokens), "meta": meta or {}}
        self._total_length += len(tokens)
        for term in freq:
            self._postings.setdefault(term, {})[doc_id] = freq[term]
            self._df[term] = self._df.get(term, 0) + 1
        self.version += 1
        return {"docId": doc_id, "tokens": len(tokens), "terms": len(freq)}

    def add_all(self, documents: Iterable[tuple[str, str]] | Iterable[tuple[str, str, dict]]) -> int:
        """Index an iterable of (doc_id, text) or (doc_id, text, meta)."""
        count = 0
        for entry in documents:
            if len(entry) == 2:
                doc_id, text = entry
                meta = {}
            else:
                doc_id, text, meta = entry
            self.add(doc_id, text, meta)
            count += 1
        return count

    def remove(self, doc_id: str) -> bool:
        doc = self._docs.get(doc_id)
        if not doc:
            return False
        self._total_length -= doc["length"]
        for token in dict.fromkeys(doc["tokens"]):
            posting = self._postings.get(token)
            if posting is not None:
                posting.pop(doc_id, None)
                if not posting:
                    del self._postings[token]
            remaining = self._df.get(token, 1) - 1
            if remaining <= 0:
                self._df.pop(token, None)
            else:
                self._df[token] = remaining
        del self._docs[doc_id]
        self.version += 1
        return True

    # --- query ------------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        top_k: int = 10,
        filter: Callable[[str, dict], bool] | None = None,
    ) -> list[SearchHit]:
        """Rank documents for a query. ``filter`` is an access-control predicate."""
        terms = list(dict.fromkeys(stem_tokens(query)))
        if not terms or not self._docs:
            return []

        avgdl = self.avgdl or 1.0
        scores: dict[str, float] = {}
        matched: dict[str, list[str]] = {}

        for term in terms:
            posting = self._postings.get(term)
            if not posting:
                continue
            idf = self.idf(term)
            for doc_id, f in posting.items():
                doc = self._docs.get(doc_id)
                if doc is None:
                    continue
                if filter is not None and not filter(doc_id, doc["meta"]):
                    continue
                denom = f + self.k1 * (1 - self.b + (self.b * doc["length"]) / avgdl)
                contribution = idf * ((f * (self.k1 + 1)) / denom)
                scores[doc_id] = scores.get(doc_id, 0.0) + contribution
                matched.setdefault(doc_id, []).append(term)

        hits = [
            SearchHit(
                docId=doc_id,
                score=score,
                meta=self._docs[doc_id]["meta"],
                matchedTerms=matched[doc_id],
            )
            for doc_id, score in scores.items()
        ]
        # Descending score, then doc_id ascending — the Node tie-break.
        hits.sort(key=lambda hit: (-hit["score"], hit["docId"]))
        return hits[: max(1, int(top_k) or 10)]

    def stats(self) -> dict:
        """Corpus statistics, recorded with every retrieval evaluation."""
        return {
            "documents": len(self._docs),
            "uniqueTerms": len(self._df),
            "totalTokens": self._total_length,
            "avgdl": round6(self.avgdl),
            "k1": self.k1,
            "b": self.b,
            "version": self.version,
        }

    def to_dict(self) -> dict:
        """Serialise for persistence and integrity hashing (mirrors ``toJSON``)."""
        return {
            "k1": self.k1,
            "b": self.b,
            "version": self.version,
            "docs": [
                {
                    "docId": doc_id,
                    "length": doc["length"],
                    "meta": doc["meta"],
                    "tokens": doc["tokens"],
                }
                for doc_id, doc in self._docs.items()
            ],
        }
