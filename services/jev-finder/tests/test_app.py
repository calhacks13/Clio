"""The HTTP contract in docs/object-finder.md, as Clio's server parses it (http-vision.ts)."""

from __future__ import annotations

import threading

import httpx
import pytest
from fastapi.testclient import TestClient

from jev_finder.app import create_app
from jev_finder.finder import Finder


@pytest.fixture
def client(fake_jev, fake_segmenter):
    finder = Finder(fake_jev.client(), fake_segmenter, "jev-1.14.0")
    with TestClient(create_app(finder, "cpu")) as client:
        yield client
    finder.close()


def locate_body(image: str, *ids: str) -> dict:
    return {
        "image": {"mimeType": "image/jpeg", "data": image},
        "objects": [
            {"id": i, "phrase": f"{i} phrase", "query": f"The {i} on the table"} for i in ids
        ],
    }


def test_locate_answers_the_finder_contract(client, fake_jev, image_b64):
    fake_jev.present("absent", 0.1)
    response = client.post("/locate", json=locate_body(image_b64(), "washer_cap", "absent"))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"model", "detections"}
    assert body["model"] == "jev-1.14.0+fake-sam"
    found, absent = body["detections"]
    assert set(found) == {"id", "found", "point", "box", "outline", "confidence"}
    assert found["id"] == "washer_cap" and found["found"] is True
    assert len(found["point"]) == 2 and len(found["box"]) == 4
    assert 3 <= len(found["outline"]) <= 64
    assert found["outline"][0] != found["outline"][-1]  # closed without repeating the start
    x0, y0, x1, y1 = found["box"]
    assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1
    assert x0 <= found["point"][0] <= x1 and y0 <= found["point"][1] <= y1
    assert absent == {
        "id": "absent",
        "found": False,
        "point": None,
        "box": None,
        "outline": None,
        "confidence": 0.1,
    }
    assert "segment;dur=" in response.headers["server-timing"]
    # Noul asks about the phrase; the standalone query is Box's context.
    questions = fake_jev.body()["questions"]
    assert questions["present_washer_cap"]["instructions"] == (
        "Is there a washer_cap phrase visible in `photo`?"
    )
    assert questions["target_washer_cap"]["instructions"].endswith(
        "Description: The washer_cap on the table"
    )


def test_health(client):
    assert client.get("/health").json() == {
        "ok": True,
        "model": "jev-1.14.0+fake-sam",
        "device": "cpu",
    }


@pytest.mark.parametrize("count", [0, 17])
def test_one_to_sixteen_objects(client, image_b64, count):
    body = locate_body(image_b64(), *[f"o{i}" for i in range(count)])
    assert client.post("/locate", json=body).status_code == 422


@pytest.mark.parametrize("query", [".", " - ", ""])
def test_query_without_words_is_422_and_never_reaches_jev(client, fake_jev, image_b64, query):
    body = locate_body(image_b64(), "cap")
    body["objects"][0]["query"] = query
    assert client.post("/locate", json=body).status_code == 422
    assert fake_jev.requests == []


def test_a_second_request_while_one_runs_is_503_not_queued(client, fake_jev, image_b64):
    fake_jev.hold = threading.Event()
    first: list[httpx.Response] = []
    running = threading.Thread(
        target=lambda: first.append(client.post("/locate", json=locate_body(image_b64(), "a")))
    )
    running.start()
    try:
        for _ in range(500):
            if fake_jev.requests:
                break
            threading.Event().wait(0.01)
        second = client.post("/locate", json=locate_body(image_b64(), "b"))
        assert second.status_code == 503
        assert "earlier request" in second.json()["detail"]
    finally:
        fake_jev.hold.set()
        running.join(5)
    assert first[0].status_code == 200
    assert len(fake_jev.requests) == 1


def test_bad_image_is_422_and_never_reaches_jev(client, fake_jev):
    response = client.post("/locate", json=locate_body("bm90IGFuIGltYWdl", "cap"))
    assert response.status_code == 422
    assert "not a readable" in response.json()["detail"]
    assert fake_jev.requests == []


def test_jev_errors_map_to_gateway_statuses(client, fake_jev, image_b64):
    fake_jev.status = 529
    response = client.post("/locate", json=locate_body(image_b64(), "cap"))
    assert response.status_code == 502
    assert "No automatic retry" in response.json()["detail"]

    fake_jev.status = 200
    fake_jev.error = httpx.ReadTimeout("slow")
    assert client.post("/locate", json=locate_body(image_b64(), "cap")).status_code == 504
    assert len(fake_jev.requests) == 2


def test_only_local_host_names_are_served(client, image_b64):
    response = client.post(
        "/locate", json=locate_body(image_b64(), "cap"), headers={"host": "evil.example"}
    )
    assert response.status_code == 403
    assert client.get("/health", headers={"host": "127.0.0.1:8790"}).status_code == 200
