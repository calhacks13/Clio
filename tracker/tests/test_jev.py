"""The jev client (from the jev finder, unchanged): the request, the gate, no retries."""

from __future__ import annotations

import base64
import threading

import httpx
import pytest

from clio_tracker.jev import (
    DEFAULT_MODEL,
    JevClient,
    JevError,
    Target,
    describe,
    question_keys,
    read_answer,
)

JPEG = b"\xff\xd8not really a jpeg"


def test_one_request_asks_noul_and_box_for_every_object(fake_jev):
    targets = [
        Target(
            "washer_cap",
            "Round blue cap with a spray symbol, at the front left.",
            "blue washer fluid cap",
        ),
        Target("dipstick", "The yellow dipstick handle", "The yellow dipstick handle"),
    ]
    reply = fake_jev.client().ask(JPEG, targets)

    assert len(fake_jev.requests) == 1
    request = fake_jev.requests[0]
    assert request.url == "https://api.typesafe.ai/v1/systemone"
    assert request.headers["authorization"] == "Bearer test-key"
    assert request.headers["typesafe-danger-zone-images"] == "true"
    body = fake_jev.body()
    assert body["model"] == DEFAULT_MODEL == "jev-1.14.0"
    (asset_id,) = body["assets"]
    assert body["state"] == {"photo": asset_id}
    asset = body["assets"][asset_id]
    assert asset["type"] == "image" and asset["format"] == "jpg"
    assert base64.b64decode(asset["data_base64"]) == JPEG
    # The phrase fills the benchmarked templates; the description is context for Box only.
    assert body["questions"] == {
        "present_washer_cap": {
            "type": "noul",
            "instructions": "Is there a blue washer fluid cap visible in `photo`?",
        },
        "target_washer_cap": {
            "type": "box",
            "instructions": "The blue washer fluid cap in `photo`. Return a tight box around "
            "one matching object. Description: Round blue cap with a spray symbol, at the front "
            "left.",
        },
        "present_dipstick": {
            "type": "noul",
            "instructions": "Is there a yellow dipstick handle visible in `photo`?",
        },
        "target_dipstick": {
            "type": "box",
            "instructions": "The yellow dipstick handle in `photo`. Return a tight box around "
            "one matching object.",
        },
    }
    assert [a.box for a in reply.answers] == [[0.3, 0.3, 0.7, 0.7]] * 2
    assert reply.usage == {"input_tokens": 3300}


def test_a_description_without_a_phrase_is_quoted_not_used_as_a_noun(fake_jev):
    query = "The object is a matte black computer mouse resting in the center of the frame."
    fake_jev.client().ask(JPEG, [Target("mouse", f"  {query} ", phrase=" . ")])
    assert fake_jev.body()["questions"] == {
        "present_mouse": {
            "type": "noul",
            "instructions": f"Is the object described below visible in `photo`? Description: "
            f"{query}",
        },
        "target_mouse": {
            "type": "box",
            "instructions": "The object described below, in `photo`. Return a tight box around "
            f"one matching object. Description: {query}",
        },
    }


def test_presence_comes_from_noul_at_one_half(fake_jev):
    fake_jev.present("a", 0.49)
    fake_jev.present("b", 0.5)
    fake_jev.present("c", 0.02)
    a, b, c = fake_jev.client().ask(JPEG, [Target(i, "cap") for i in "abc"]).answers
    # Box always answers with some box; below the gate it is dropped.
    assert (a.present, a.presence, a.box) == (False, 0.49, None)
    assert (b.present, b.presence, b.box) == (True, 0.5, [0.3, 0.3, 0.7, 0.7])
    assert not c.present and c.box is None and c.problem is None


@pytest.mark.parametrize(
    "box",
    [
        [0.4, 0.2, 0.4, 0.6],  # zero width, which jev has been reported to return
        [0.5, 0.2, 0.3, 0.6],  # left of right swapped
        [0.1, 0.2, 1.2, 0.6],  # outside the image
        [0.1, 0.2, 0.5, float("nan")],
    ],
)
def test_invalid_box_is_dropped_not_repaired(box):
    answers = {
        "present_cap": {"type": "noul", "noul": 0.8},
        "target_cap": {
            "type": "box",
            "box": dict(zip(("left", "top", "right", "bottom"), box, strict=True)),
        },
    }
    answer = read_answer(answers, "cap")
    assert answer.presence == 0.8 and answer.present
    assert answer.box is None
    assert "invalid box" in answer.problem


def test_unusable_answers():
    assert read_answer({}, "cap").presence is None
    assert not read_answer({"present_cap": {"noul": 1.5}}, "cap").present
    assert not read_answer({"present_cap": {"noul": True}}, "cap").present
    missing_box = read_answer({"present_cap": {"noul": 0.9}}, "cap")
    assert missing_box.present and missing_box.box is None
    assert missing_box.problem == "no Box answer for target_cap"


def test_http_error_is_not_retried(fake_jev):
    fake_jev.status = 529
    with pytest.raises(JevError) as raised:
        fake_jev.client().ask(JPEG, [Target("cap", "cap")])
    assert raised.value.status == 502
    assert "HTTP 529: overloaded" in str(raised.value)
    assert "No automatic retry" in str(raised.value)
    assert len(fake_jev.requests) == 1


def test_timeout_is_not_retried(fake_jev):
    fake_jev.error = httpx.ReadTimeout("slow")
    with pytest.raises(JevError) as raised:
        fake_jev.client(timeout_s=2).ask(JPEG, [Target("cap", "cap")])
    assert raised.value.status == 504
    assert "within 2 s" in str(raised.value)
    assert len(fake_jev.requests) == 1


def test_deadline_caps_the_call_and_a_late_call_blocks_the_next(fake_jev):
    fake_jev.hold = threading.Event()
    client = fake_jev.client(timeout_s=0.05)
    with pytest.raises(JevError) as late:
        client.ask(JPEG, [Target("cap", "cap")])
    assert late.value.status == 504 and "within 0.05 s" in str(late.value)

    # The late call may still be billed: nothing else is sent until it ends.
    with pytest.raises(JevError) as busy:
        client.ask(JPEG, [Target("cap", "cap")])
    assert busy.value.status == 503 and "not sent" in str(busy.value)
    assert len(fake_jev.requests) == 1

    fake_jev.hold.set()
    client.caller.submit(lambda: None).result(1)  # the late call has ended
    fake_jev.hold = None
    assert client.ask(JPEG, [Target("cap", "cap")]).answers[0].present
    assert len(fake_jev.requests) == 2


def test_stage_timeouts_stay_within_the_deadline():
    timeout = JevClient("k", timeout_s=12).client.timeout
    assert (timeout.connect, timeout.write, timeout.pool, timeout.read) == (3, 3, 1, 12)


def test_unreachable_and_malformed_answers():
    def unreachable(request):
        raise httpx.ConnectError("refused")

    client = JevClient("k", transport=httpx.MockTransport(unreachable))
    with pytest.raises(JevError, match="unreachable"):
        client.ask(JPEG, [Target("cap", "cap")])

    garbled = JevClient("k", transport=httpx.MockTransport(lambda r: httpx.Response(200, text="?")))
    with pytest.raises(JevError, match="no answers object"):
        garbled.ask(JPEG, [Target("cap", "cap")])


def test_missing_key_is_refused():
    with pytest.raises(ValueError, match="TYPESAFE_API_KEY"):
        JevClient("")


def test_question_keys_are_safe_and_unique():
    assert question_keys(["cap", "washer_cap", "has space", "cap", "über"]) == [
        "cap",
        "washer_cap",
        "object2",
        "cap_",
        "object4",
    ]


def test_describe_makes_a_subject():
    assert describe("A round blue cap.") == "round blue cap"
    assert describe("the RJ45 plug") == "RJ45 plug"
    assert describe("USB cable") == "USB cable"
    assert describe("  Red   mug ") == "red mug"
    assert describe(" . ") == ""
