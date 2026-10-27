"""Tokenisation and stemming, deliberately identical to the Node retriever.

The Aetheris Lite retriever is evaluated against the BM25 index that
``services/core/src/knowledge/bm25.mjs`` actually serves in production. For that
comparison to mean anything, both sides must segment text the same way: a
stronger embedding model beating a weaker *tokeniser* would prove nothing about
retrieval quality.

So this module mirrors ``services/core/src/knowledge/text.mjs`` rule for rule —
same normalisation, same token regex, same length floor, same 149 stopwords,
same suffix-stripping stemmer, same BM25 IDF. ``tests/test_bm25_parity.py``
pins the two implementations against shared fixtures, so a change on either side
fails the other's test rather than silently invalidating the benchmark.

The stemmer is naive on purpose. It is a real algorithm, not a model, and the
model card says so.
"""

from __future__ import annotations

import re
from typing import Iterable

__all__ = [
    "STOPWORDS",
    "normalize_text",
    "tokenize",
    "content_tokens",
    "stem",
    "stem_tokens",
    "split_sentences",
    "chunk_text",
    "sha256_of",
]

#: Identical to the list in ``services/core/src/knowledge/text.mjs``.
STOPWORDS = frozenset({
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
    "aren", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
    "but", "by", "can", "cannot", "could", "couldn", "did", "didn", "do", "does", "doesn",
    "doing", "don", "down", "during", "each", "few", "for", "from", "further", "had", "hadn",
    "has", "hasn", "have", "haven", "having", "he", "her", "here", "hers", "herself", "him",
    "himself", "his", "how", "i", "if", "in", "into", "is", "isn", "it", "its", "itself",
    "just", "let", "me", "might", "more", "most", "must", "my", "myself", "no", "nor", "not",
    "now", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours",
    "ourselves", "out", "over", "own", "same", "shan", "she", "should", "shouldn", "so",
    "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then",
    "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up",
    "upon", "very", "was", "wasn", "we", "were", "weren", "what", "when", "where", "which",
    "while", "who", "whom", "why", "will", "with", "within", "without", "won", "would",
    "wouldn", "you", "your", "yours", "yourself", "yourselves",
})

# Same rule as the Node tokenizer: /[A-Za-z0-9_][A-Za-z0-9_'-]*/g
_TOKEN_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_'-]*")
_DIGIT_RE = re.compile(r"[0-9]")

_LONG_SUFFIXES = ("ational", "iveness", "fulness", "ousness", "ization", "isation")
_SHORT_SUFFIXES = ("ing", "edly", "ies", "ied")


def normalize_text(value: object) -> str:
    """CRLF to LF, non-breaking space to space, collapse runs of spaces/tabs."""
    text = "" if value is None else str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ")
    return re.sub(r"[ \t]+", " ", text)


def tokenize(text: object) -> list[str]:
    """Lowercase word tokens. Single characters are dropped unless numeric."""
    source = normalize_text(text)
    tokens: list[str] = []
    for match in _TOKEN_RE.finditer(source):
        token = match.group(0).lower()
        if len(token) < 2 and not _DIGIT_RE.search(token):
            continue
        tokens.append(token)
    return tokens


def content_tokens(text: object) -> list[str]:
    """Tokens with stopwords removed — the discriminating terms."""
    return [token for token in tokenize(text) if token not in STOPWORDS]


def stem(token: str) -> str:
    """Strip common English suffixes. Naive but real; not a replacement for a model."""
    t = token
    if len(t) > 4:
        for suffix in _LONG_SUFFIXES:
            if t.endswith(suffix):
                return t[: -len(suffix)] + "e"
    if len(t) > 3:
        for suffix in _SHORT_SUFFIXES:
            if t.endswith(suffix):
                return t[: -len(suffix)]
        if t.endswith("es") and len(t) > 4:
            return t[:-1]
        if t.endswith("s") and not t.endswith("ss") and not t.endswith("us"):
            return t[:-1]
    return t


def stem_tokens(text: object) -> list[str]:
    out: list[str] = []
    for token in content_tokens(text):
        out.append(stem(token))
        # Hyphenated identifiers (`zephyr-9`, `klyvaron-pro-lm`) are single
        # tokens to the tokenizer, so a search for one part (`ZEPHYR`) could
        # never match them. Index the parts alongside the whole token, under
        # the same rules the tokenizer applies to standalone tokens (min
        # length, stopwords). Mirrors `stemTokens` in the Node implementation;
        # `tokenize()` itself is unchanged so offsets still see whole tokens.
        if "-" in token:
            for part in token.split("-"):
                if not part:
                    continue
                if len(part) < 2 and not _DIGIT_RE.search(part):
                    continue
                if part in STOPWORDS:
                    continue
                out.append(stem(part))
    return out


def split_sentences(text: object) -> list[dict]:
    """Sentence splitter matching ``splitSentences`` in the Node implementation.

    Splits on sentence-final punctuation (with trailing quotes/brackets) and on
    newlines, keeping each sentence's offsets into the normalised source.
    """
    source = normalize_text(text)
    sentences: list[dict] = []
    # JS: /[^.!?\n]+[.!?]+["')\]]*|[^.!?\n]+$/g   ($ without /m is end-of-input,
    # so \Z is used here — Python's $ would also match before a trailing newline).
    pattern = re.compile(r"""[^.!?\n]+[.!?]+["')\]]*|[^.!?\n]+\Z""")
    for match in pattern.finditer(source):
        raw = match.group(0)
        trimmed = raw.strip()
        if not trimmed:
            continue
        lead = len(raw) - len(raw.lstrip())
        sentences.append(
            {
                "text": trimmed,
                "start": match.start() + lead,
                "end": match.start() + len(raw.rstrip()),
            }
        )
    return sentences


def chunk_text(
    text: object,
    *,
    target_chars: int = 1200,
    max_chars: int = 2000,
    overlap_chars: int = 160,
) -> list[dict]:
    """Sentence-aware chunking with overlap, matching the Node chunker exactly.

    Returns ``[{"text", "start", "end", "index"}]``. A single sentence longer
    than ``max_chars`` (a long code line, a table row) is hard-split, because
    otherwise one chunk could exceed the cap the retriever assumes.
    """
    source = normalize_text(text)
    if not source.strip():
        return []
    if len(source) <= max_chars:
        return [{"text": source, "start": 0, "end": len(source), "index": 0}]

    chunks: list[dict] = []
    current = ""
    current_start = 0
    next_start = 0

    for sentence in split_sentences(source):
        if not current:
            current = sentence["text"]
            current_start = sentence["start"]
        elif len(current) + len(sentence["text"]) + 1 <= target_chars:
            current = f"{current} {sentence['text']}"
        else:
            chunks.append(
                {
                    "text": current.strip(),
                    "start": current_start,
                    "end": sentence["start"],
                    "index": len(chunks),
                }
            )
            # Carry overlap from the tail of the finished chunk, so a query that
            # matches a boundary phrase still retrieves its context.
            overlap = current[max(0, len(current) - overlap_chars) :] if overlap_chars > 0 else ""
            if overlap:
                current = f"{overlap.strip()} {sentence['text']}"
                current_start = max(current_start, sentence["start"] - len(overlap))
            else:
                current = sentence["text"]
                current_start = sentence["start"]
        next_start = sentence["end"]

        while len(current) > max_chars:
            head = current[:max_chars]
            chunks.append(
                {
                    "text": head.strip(),
                    "start": current_start,
                    "end": current_start + max_chars,
                    "index": len(chunks),
                }
            )
            step = max(0, max_chars - overlap_chars)
            current = current[step:]
            current_start += step

    if current.strip():
        chunks.append({"text": current.strip(), "start": current_start, "end": next_start, "index": len(chunks)})
    return [chunk for chunk in chunks if chunk["text"]]


def sha256_of(content: str) -> str:
    """Full hex digest. Upstream truncated to 16 chars; a manifest should not."""
    import hashlib

    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def vocabulary(texts: Iterable[str]) -> list[str]:
    """Sorted unique stemmed content terms — the embedding model's token table."""
    seen: set[str] = set()
    for text in texts:
        seen.update(stem_tokens(text))
    return sorted(seen)
