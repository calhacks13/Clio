"""What a lesson's plan (meta.plan, packages/protocol/src/procedure.ts) says about an object in
words: its label and description, the detector prompt the camera looked for it with
(`tracking.query`), the phrases and descriptions of the steps that showed it, and the declared
objects that are parts of it (`partOf`). The primitive backend reads the names for whether the
thing is round; gemini-cad sends all of it with the crops.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ObjectWords:
    label: str
    kind: str | None
    description: str | None
    query: str | None  # tracking.query: the open-vocabulary detector prompt
    phrases: tuple[str, ...]  # show items' 2-5 word noun phrases
    descriptions: tuple[str, ...]  # show items' standalone visual descriptions
    parts: tuple[str, ...]  # declared objects that are part of this one, by label

    def names(self) -> list[str]:
        """The short names: label, detector prompt, phrases."""
        return _unique([self.label, self.query or "", *self.phrases])

    def hints(self) -> list[str]:
        """Every other thing the plan says it looks like, without the label."""
        out = _unique([self.query or "", *self.phrases, self.description or "", *self.descriptions])
        return [h for h in out if h.casefold() != self.label.casefold()]


def object_words(plan: dict[str, Any] | None, obj_id: str, label: str) -> ObjectWords:
    objects = [o for o in (plan or {}).get("objects", []) if isinstance(o, dict)]
    spec = next((o for o in objects if o.get("id") == obj_id), {})
    tracking = spec.get("tracking") if isinstance(spec.get("tracking"), dict) else {}
    phrases: list[str] = []
    descriptions: list[str] = []
    for step in (plan or {}).get("steps", []):
        for item in step.get("show", []) if isinstance(step, dict) else []:
            if isinstance(item, dict) and item.get("object") == obj_id:
                phrases.append(_text(item.get("phrase")))
                descriptions.append(_text(item.get("description")))
    parts = [_text(o.get("label")) for o in objects if o.get("partOf") == obj_id]
    return ObjectWords(
        label=label,
        kind=spec.get("kind"),
        description=_text(spec.get("description")) or None,
        query=_text(tracking.get("query")) or None,
        phrases=tuple(_unique(phrases)),
        descriptions=tuple(_unique(descriptions)),
        parts=tuple(_unique(parts)),
    )


def _text(value: Any) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for value in values:
        key = value.casefold()
        if value and key not in seen:
            seen.add(key)
            out.append(value)
    return out
