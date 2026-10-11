"""Small shared plumbing for the dict-backed records Fabric writes into manifests."""

from __future__ import annotations

__all__ = ["RecordMixin"]


class RecordMixin(dict):
    """A dict whose keys are also readable as attributes.

    Fabric's records are written into run manifests and experiment ledgers, so they
    must serialise as plain JSON dicts. But callers read them far more often than
    they serialise them, and ``report.exactDuplicates`` is clearer than
    ``report["exactDuplicates"]``.

    ``__getattr__`` is only consulted when normal attribute lookup fails, so real
    methods are never shadowed and a missing key still raises AttributeError rather
    than returning None and hiding a typo.

    Do NOT mix this into a ``@dataclass``. A dataclass stores its state in instance
    attributes, so the dict part stays empty — and an empty dict is falsy. Every
    ``if record.provenance`` guard would then be False and the field would serialise
    to ``null``, which is exactly the bug this note was added for. Dataclasses do not
    need it: their attributes are already attributes.
    """

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(f"{type(self).__name__} has no field {name!r}") from None
