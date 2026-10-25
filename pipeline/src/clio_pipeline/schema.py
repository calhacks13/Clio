"""Validate episode files against the protocol's JSON Schemas.

The schemas are generated from packages/protocol (zod) into packages/protocol/schema/*.schema.json.
They are found by walking up from this file to the repository (or via $CLIO_SCHEMA_DIR).
"""

from __future__ import annotations

import heapq
import json
import os
import reprlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, validators
from jsonschema.exceptions import ValidationError, relevance
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from .frames import HAND_JOINTS, JOINT_FIELDS

SCHEMA_DIR_ENV = "CLIO_SCHEMA_DIR"

# Episode file -> (schema file, one JSON record per line, required)
EPISODE_FILES: dict[str, tuple[str, bool, bool]] = {
    "meta.json": ("episode-meta.schema.json", False, True),
    "frames.ndjson": ("frame-record.schema.json", True, True),
    "events.ndjson": ("episode-event.schema.json", True, True),
    "objects.ndjson": ("object-track.schema.json", True, False),
    "observations.ndjson": ("object-observation.schema.json", True, False),
    "finish.json": ("episode-finish.schema.json", False, False),
}

# Compiled document (clio.derived/1, packages/protocol/src/derived.ts) -> schema file
DERIVED_SCHEMAS: dict[str, str] = {
    "manifest": "derived-manifest.schema.json",
    "tracks": "derived-tracks.schema.json",
    "environment": "derived-environment.schema.json",
    "shapes": "derived-shapes.schema.json",
    "retarget": "derived-retarget.schema.json",
}


@dataclass(frozen=True)
class ValidationIssue:
    """One problem in one file. `line` is 1-based (NDJSON files); `path` is a JSON path."""

    file: str
    line: int | None
    path: str | None
    message: str

    def __str__(self) -> str:
        where = self.file if self.line is None else f"{self.file}:{self.line}"
        return f"{where}: {self.path}: {self.message}" if self.path else f"{where}: {self.message}"


class EpisodeValidationError(ValueError):
    """Raised by `load_episode(..., validate=True)` for an invalid episode."""

    def __init__(self, episode_dir: Path, issues: list[ValidationIssue]) -> None:
        self.episode_dir = episode_dir
        self.issues = issues
        shown = "\n".join(f"  {issue}" for issue in issues[:10])
        more = f"\n  ... and {len(issues) - 10} more" if len(issues) > 10 else ""
        super().__init__(f"{episode_dir} is not a valid Clio episode:\n{shown}{more}")


def find_schema_dir() -> Path:
    """$CLIO_SCHEMA_DIR, else the nearest packages/protocol/schema above this package."""
    if env := os.environ.get(SCHEMA_DIR_ENV):
        return Path(env)
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "packages" / "protocol" / "schema"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError(
        f"Cannot find packages/protocol/schema above {here}; set ${SCHEMA_DIR_ENV} to point at it"
    )


_NUMBER_ITEMS = {"type": "number"}
_draft_items = Draft202012Validator.VALIDATORS["items"]


def _items(validator, items, instance, schema):
    """`items`, with a fast path for arrays of plain numbers (the 200 joint values of every hand
    in every frame). Anything else, including any non-number element, goes through jsonschema's
    own implementation, so errors and their paths are unchanged."""
    if items == _NUMBER_ITEMS and "prefixItems" not in schema and isinstance(instance, list):
        if all(type(x) is float or type(x) is int for x in instance):  # bool is not a number
            return
    yield from _draft_items(validator, items, instance, schema)


_Validator = validators.extend(Draft202012Validator, {"items": _items})


class SchemaSet:
    """The protocol's JSON Schemas, registered by `$id` so every `$ref` resolves."""

    def __init__(self, schema_dir: Path | str | None = None) -> None:
        self.dir = Path(schema_dir) if schema_dir is not None else find_schema_dir()
        paths = sorted(self.dir.glob("*.schema.json"))
        if not paths:
            raise FileNotFoundError(f"No *.schema.json files in {self.dir}")
        self.schemas: dict[str, dict] = {p.name: json.loads(p.read_text()) for p in paths}
        self.registry: Registry = Registry().with_resources(
            (schema.get("$id", name), Resource.from_contents(schema, DRAFT202012))
            for name, schema in self.schemas.items()
        )
        self._validators: dict[str, Draft202012Validator] = {}

    def validator(self, name: str) -> Draft202012Validator:
        if name not in self._validators:
            if name not in self.schemas:
                raise KeyError(f"No schema {name!r} in {self.dir}")
            self._validators[name] = _Validator(self.schemas[name], registry=self.registry)
        return self._validators[name]

    def check(self, name: str, record: Any) -> list[tuple[str, str]]:
        """(JSON path, message) for each top-level error of `record`; empty when valid."""
        errors = sorted(self.validator(name).iter_errors(record), key=lambda e: list(e.path))
        return [describe_error(e) for e in errors]

    def first_problem(self, name: str, record: Any) -> tuple[str, str] | None:
        """The single most relevant (path, message), or None when valid."""
        errors = list(self.validator(name).iter_errors(record))
        return describe_error(max(errors, key=relevance)) if errors else None


@lru_cache(maxsize=4)
def _schemas_in(schema_dir: Path) -> SchemaSet:
    return SchemaSet(schema_dir)


def default_schemas() -> SchemaSet:
    return _schemas_in(find_schema_dir().resolve())


# --- validation -----------------------------------------------------------------------------------


def validate_episode(
    episode_dir: Path | str,
    *,
    schemas: SchemaSet | None = None,
    max_issues_per_file: int = 20,
) -> list[ValidationIssue]:
    """Check every file of an episode directory. Returns the issues found (empty means valid)."""
    episode_dir = Path(episode_dir)
    if not episode_dir.is_dir():
        return [ValidationIssue(str(episode_dir), None, None, "not a directory")]
    schemas = schemas if schemas is not None else default_schemas()
    issues: list[ValidationIssue] = []
    for file, (schema_name, ndjson, required) in EPISODE_FILES.items():
        path = episode_dir / file
        if not path.exists():
            if required:
                issues.append(ValidationIssue(file, None, None, "file is missing"))
            continue
        if ndjson:
            issues += _validate_ndjson(path, schema_name, schemas, max_issues_per_file)
        else:
            issues += _validate_json(path, schema_name, schemas)
    return issues


def _validate_json(path: Path, schema_name: str, schemas: SchemaSet) -> list[ValidationIssue]:
    file = path.name
    try:
        record = parse_json(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        return [ValidationIssue(file, None, None, _json_error(e))]
    problems = schemas.check(schema_name, record)
    if not problems and file == "meta.json":
        problems = hand_layout_problems(record)
    return [ValidationIssue(file, None, p, m) for p, m in problems]


def _validate_ndjson(
    path: Path, schema_name: str, schemas: SchemaSet, max_issues: int
) -> list[ValidationIssue]:
    file = path.name
    issues: list[ValidationIssue] = []
    invalid = 0
    prev_t: float | None = None
    for lineno, raw in _numbered_lines(path):
        problem = None
        try:
            record = parse_json(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            problem = (None, _json_error(e))
        else:
            problem = schemas.first_problem(schema_name, record)
            t = record.get("t") if isinstance(record, dict) else None
            if isinstance(t, int | float) and not isinstance(t, bool):
                if problem is None and prev_t is not None and t < prev_t:
                    problem = ("$.t", f"t = {t} ms is before the previous line's t = {prev_t} ms")
                prev_t = t
        if problem is not None:
            invalid += 1
            if len(issues) < max_issues:
                issues.append(ValidationIssue(file, lineno, *problem))
    if invalid > max_issues:
        issues.append(
            ValidationIssue(
                file,
                None,
                None,
                f"{invalid} invalid lines in total; showing the first {max_issues}",
            )
        )
    return issues


def _numbered_lines(path: Path) -> Iterator[tuple[int, bytes]]:
    """(1-based line number, raw line) for every non-blank line."""
    with path.open("rb") as f:
        for lineno, raw in enumerate(f, start=1):
            if raw.strip():
                yield lineno, raw


def derived_problems(
    doc: Any, kind: str, *, schemas: SchemaSet | None = None
) -> list[tuple[str, str]]:
    """(JSON path, message) for each way a compiled document breaks its schema. `kind` is
    `manifest`, `tracks`, `environment`, `shapes` or `retarget`."""
    if kind not in DERIVED_SCHEMAS:
        raise KeyError(f"unknown compiled document kind {kind!r}")
    schemas = schemas if schemas is not None else default_schemas()
    return schemas.check(DERIVED_SCHEMAS[kind], doc)


def validate_derived(
    derived_dir: Path | str, *, schemas: SchemaSet | None = None
) -> list[ValidationIssue]:
    """Check a compiled episode directory: manifest.json and every artifact it lists."""
    derived_dir = Path(derived_dir)
    schemas = schemas if schemas is not None else default_schemas()
    try:
        manifest = parse_json((derived_dir / "manifest.json").read_text(encoding="utf-8"))
    except OSError:
        return [ValidationIssue("manifest.json", None, None, "file is missing")]
    except (ValueError, UnicodeDecodeError) as e:
        return [ValidationIssue("manifest.json", None, None, _json_error(e))]
    problems = derived_problems(manifest, "manifest", schemas=schemas)
    issues = [ValidationIssue("manifest.json", None, p, m) for p, m in problems]
    if problems:
        return issues
    for artifact in manifest["artifacts"]:
        name = artifact["name"]
        try:
            doc = parse_json((derived_dir / name).read_text(encoding="utf-8"))
        except OSError:
            issues.append(ValidationIssue(name, None, None, "file is missing"))
            continue
        except (ValueError, UnicodeDecodeError) as e:
            issues.append(ValidationIssue(name, None, None, _json_error(e)))
            continue
        problems = derived_problems(doc, artifact["kind"], schemas=schemas)
        issues += [ValidationIssue(name, None, p, m) for p, m in problems]
    return issues


def hand_layout_problems(meta: dict) -> list[tuple[str, str]]:
    """The loader reads frames in WebXR joint order; anything else would be silently misread."""
    hands = meta.get("hands", {})
    problems = []
    if list(hands.get("joints", [])) != list(HAND_JOINTS):
        problems.append(("$.hands.joints", "joint order differs from the WebXR order (hand.ts)"))
    if list(hands.get("jointFields", [])) != list(JOINT_FIELDS):
        problems.append(("$.hands.jointFields", f"expected {list(JOINT_FIELDS)}"))
    return problems


# --- transfer integrity -------------------------------------------------------------------------


def read_bookkeeping(episode_dir: Path | str) -> dict[str, list[int]] | None:
    """The server's batches.json ({received, gaps}: batch seqs), or None if there is none."""
    path = Path(episode_dir) / "batches.json"
    if not path.is_file():
        return None
    book = parse_json(path.read_text(encoding="utf-8"))
    return {"received": [int(s) for s in book["received"]], "gaps": [int(s) for s in book["gaps"]]}


def transfer_warnings(episode_dir: Path | str) -> list[ValidationIssue]:
    """Signs that batches were lost between headset and server (docs/data-format.md: finish.json's
    `batches` should match what batches.json received). Not schema errors: the files are valid,
    just incomplete."""
    episode_dir = Path(episode_dir)
    try:
        book = read_bookkeeping(episode_dir)
    except (ValueError, KeyError, TypeError, UnicodeDecodeError) as e:
        return [ValidationIssue("batches.json", None, None, f"unreadable ({e})")]
    if book is None:
        return []
    warnings = []
    if book["gaps"]:
        gaps = book["gaps"]
        listed = ", ".join(map(str, gaps[:10])) + (", ..." if len(gaps) > 10 else "")
        noun = "seq" if len(gaps) == 1 else "seqs"
        warnings.append(
            ValidationIssue("batches.json", None, None, f"batch {noun} {listed} never arrived")
        )
    finish_path = episode_dir / "finish.json"
    try:
        sent = parse_json(finish_path.read_text(encoding="utf-8"))["batches"]
    except (OSError, ValueError, KeyError, TypeError):
        sent = None
    if isinstance(sent, int) and sent != len(book["received"]):
        warnings.append(
            ValidationIssue(
                "batches.json",
                None,
                None,
                f"finish.json says {sent} batches were sent, the server received "
                f"{len(book['received'])}",
            )
        )
    return warnings


# --- JSON parsing ---------------------------------------------------------------------------------


def _reject_constant(name: str) -> float:
    raise ValueError(f"non-finite number {name} is not allowed")


def parse_json(text: str) -> Any:
    """json.loads, but NaN/Infinity (which Python accepts and JSON forbids) are errors."""
    return json.loads(text, parse_constant=_reject_constant)


def _json_error(e: Exception) -> str:
    if isinstance(e, json.JSONDecodeError):
        return f"invalid JSON at column {e.colno}: {e.msg}"
    if isinstance(e, UnicodeDecodeError):
        return "invalid UTF-8"
    return f"invalid JSON: {e}"


# --- error descriptions ---------------------------------------------------------------------------

_short = reprlib.Repr()
_short.maxlist = _short.maxtuple = 4
_short.maxdict = 4
_short.maxstring = 60
_short.maxother = 60
_short.maxlevel = 2


def describe_error(error: ValidationError) -> tuple[str, str]:
    """(JSON path, message) for the most specific cause of `error`.

    `oneOf`/`anyOf` unions whose branches are told apart by a constant property (event `type`,
    check `type`, placement `method`, plan origin `kind`) descend into the branch the instance
    selects, so the message is about that branch instead of "not valid under any of the given
    schemas" or a mismatch with some other branch.
    """
    while error.context:
        selected = _selected_branch(error)
        if isinstance(selected, str):
            return json_path(error.absolute_path), selected
        if selected:
            error = max(selected, key=relevance)
            continue
        smallest = heapq.nsmallest(2, error.context, key=relevance)
        if len(smallest) == 2 and relevance(smallest[0]) == relevance(smallest[1]):
            break  # no single best branch (same rule as jsonschema.exceptions.best_match)
        error = smallest[0]
    return json_path(error.absolute_path), _message(error)


def _selected_branch(error: ValidationError) -> list[ValidationError] | str | None:
    if error.validator not in ("oneOf", "anyOf") or not isinstance(error.instance, dict):
        return None
    disc = _discriminator(error.validator_value)
    if disc is None:
        return None
    key, index_of = disc
    if key not in error.instance:
        return f"{key!r} is a required property"
    value = error.instance[key]
    if not isinstance(value, str) or value not in index_of:
        return f"unknown {key} {value!r}; expected one of: {', '.join(index_of)}"
    branch = index_of[value]
    return [e for e in error.context if e.relative_schema_path[0] == branch] or None


def _discriminator(branches: Any) -> tuple[str, dict[str, int]] | None:
    """A property every branch pins to a distinct string `const`, with its branch indices."""
    if not isinstance(branches, list) or len(branches) < 2:
        return None
    common: set[str] | None = None
    for branch in branches:
        props = branch.get("properties", {}) if isinstance(branch, dict) else {}
        keys = {
            k for k, p in props.items() if isinstance(p, dict) and isinstance(p.get("const"), str)
        }
        common = keys if common is None else common & keys
    for key in sorted(common or ()):
        values = [branch["properties"][key]["const"] for branch in branches]
        if len(set(values)) == len(values):
            return key, {v: i for i, v in enumerate(values)}
    return None


def _message(error: ValidationError) -> str:
    if error.validator in ("minItems", "maxItems") and isinstance(error.instance, list):
        bound = "at least" if error.validator == "minItems" else "at most"
        return f"expected {bound} {error.validator_value} items, got {len(error.instance)}"
    message = error.message
    if len(message) > 200:
        full = repr(error.instance)
        message = (
            message.replace(full, _short.repr(error.instance), 1)
            if full in message
            else message[:197] + "..."
        )
    return message


def json_path(parts: Iterable[str | int]) -> str:
    out = "$"
    for part in parts:
        if isinstance(part, int):
            out += f"[{part}]"
        elif part.isidentifier():
            out += f".{part}"
        else:
            out += f"[{json.dumps(part)}]"
    return out
