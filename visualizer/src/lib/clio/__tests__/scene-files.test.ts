import { describe, expect, test } from "bun:test";
import type { EnvironmentDoc } from "@clio/protocol";
import type { Fetch } from "@clio-viewer/api";
import { syntheticDerived } from "../__fixtures__/synthetic-derived";
import { syntheticEpisode } from "../__fixtures__/synthetic-episode";
import {
  syntheticRoom,
  syntheticScene,
  withRoom,
} from "../__fixtures__/synthetic-scene";
import {
  FILE_BACKOFF_MAX_MS,
  FILE_BACKOFF_MIN_MS,
  LazyFile,
  modelFiles,
  roomFile,
  sceneFileUrl,
} from "../scene-files";

// Which binary files the scene reads (the room scan, the generated models)
// for which toggles and documents, and how one file is read: once per
// version, a 404 or a body that does not parse as absent, other failures
// retried with a backoff, and nothing held once its layer is hidden.

const EPISODE = syntheticEpisode();
const ID = EPISODE.meta.episodeId;
const COMPILED = syntheticDerived(EPISODE);
const ROOM = syntheticRoom(EPISODE);
const SCENE = syntheticScene(EPISODE, COMPILED.manifest);
const COMPILED_AT = COMPILED.manifest.compiledAt;

const derived = {
  episodeId: ID,
  environment: withRoom(COMPILED.environment, ROOM),
  compiledAt: COMPILED_AT,
};

describe("which files the scene reads", () => {
  test("the room scan, while the Room toggle is on", () => {
    expect(roomFile(derived, true)).toEqual({
      url: `/api/clio/episodes/${ID}/derived/room.glb`,
      name: "room.glb",
      version: COMPILED_AT,
      key: `${COMPILED_AT} /api/clio/episodes/${ID}/derived/room.glb`,
    });
    expect(roomFile(derived, false)).toBeNull();
  });

  test("no room scan without one in environment.json, or before a compile", () => {
    // A compiler before 0.7.0 leaves `room` out; a compile without a scan writes null.
    const older: EnvironmentDoc = { ...derived.environment };
    delete older.room;
    expect(roomFile({ ...derived, environment: older }, true)).toBeNull();
    expect(
      roomFile(
        { ...derived, environment: { ...derived.environment, room: null } },
        true,
      ),
    ).toBeNull();
    expect(roomFile({ ...derived, environment: null }, true)).toBeNull();
    expect(roomFile({ ...derived, compiledAt: null }, true)).toBeNull();
    expect(roomFile({ ...derived, episodeId: null }, true)).toBeNull();
  });

  test("a new compile is a new version of the same room scan", () => {
    const before = roomFile(derived, true);
    const after = roomFile(
      { ...derived, compiledAt: "2026-10-24T12:09:00.000Z" },
      true,
    );
    expect(after?.url).toBe(before?.url ?? "");
    expect(after?.key).not.toBe(before?.key ?? "");
  });

  test("each object's model, while the Models toggle is on", () => {
    const files = modelFiles({ episodeId: ID, scene: SCENE.doc }, true);
    expect([...files.keys()]).toEqual(["syringe", "cup_a", "indicator"]);
    const syringe = files.get("syringe");
    expect(syringe?.model).toBe(SCENE.doc.objects[0]);
    expect(syringe?.file).toEqual({
      url: `/api/clio/episodes/${ID}/scene/model-syringe.glb`,
      name: "model-syringe.glb",
      version: SCENE.doc.builtAt,
      key: `${SCENE.doc.builtAt} /api/clio/episodes/${ID}/scene/model-syringe.glb`,
    });
    expect(modelFiles({ episodeId: ID, scene: SCENE.doc }, false).size).toBe(0);
    expect(modelFiles({ episodeId: ID, scene: null }, true).size).toBe(0);
    expect(modelFiles({ episodeId: null, scene: SCENE.doc }, true).size).toBe(
      0,
    );
  });

  test("an object no model could be made for has none to read", () => {
    const scene = {
      ...SCENE.doc,
      objects: SCENE.doc.objects.map((m) =>
        m.id === "cup_a" ? { ...m, model: null } : m,
      ),
    };
    expect([...modelFiles({ episodeId: ID, scene }, true).keys()]).toEqual([
      "syringe",
      "indicator",
    ]);
  });

  test("a crop's URL through the proxy", () => {
    expect(sceneFileUrl(ID, "crop-syringe-1.jpg")).toBe(
      `/api/clio/episodes/${ID}/scene/crop-syringe-1.jpg`,
    );
    expect(sceneFileUrl(null, "crop-syringe-1.jpg")).toBeNull();
  });
});

/** A file server answering each request from a list, then repeating the last answer. */
function server(...answers: (Response | (() => Promise<Response>))[]) {
  const requests: string[] = [];
  const signals: AbortSignal[] = [];
  const fetch: Fetch = async (input, init) => {
    requests.push(input);
    if (init?.signal) signals.push(init.signal);
    const answer = answers[Math.min(requests.length, answers.length) - 1];
    return typeof answer === "function" ? answer() : answer.clone();
  };
  return { fetch, requests, signals };
}

const bytes = (text: string) => new Response(new TextEncoder().encode(text));
const decode = async (b: ArrayBuffer) => new TextDecoder().decode(b);
const URL = `/api/clio/episodes/${ID}/scene/model-syringe.glb`;

function fileOn(
  fetch: Fetch,
  parse: (b: ArrayBuffer) => Promise<string> = decode,
  disposed: string[] = [],
) {
  return new LazyFile<string>({
    url: URL,
    parse,
    dispose: (value) => disposed.push(value),
    fetch,
    now: () => 1000,
  });
}

describe("reading one file", () => {
  test("a file is read once and parsed", async () => {
    const s = server(bytes("glb"));
    const file = fileOn(s.fetch);
    expect(file.getSnapshot().status).toBe("idle");
    expect(await file.step()).toBeNull();
    expect(file.getSnapshot()).toEqual({
      status: "ok",
      value: "glb",
      error: null,
    });
    expect(await file.step()).toBeNull();
    expect(s.requests).toEqual([URL]);
  });

  test("a 404 is absent and is not read again", async () => {
    const s = server(Response.json({ error: "not_found" }, { status: 404 }));
    const file = fileOn(s.fetch);
    expect(await file.step()).toBeNull();
    expect(file.getSnapshot()).toEqual({
      status: "missing",
      value: null,
      error: null,
    });
    expect(await file.step()).toBeNull();
    expect(s.requests.length).toBe(1);
  });

  test("a body that does not parse is invalid, and absent", async () => {
    const s = server(bytes("not a glb"));
    const file = fileOn(s.fetch, async () => {
      throw new Error("Unexpected magic");
    });
    expect(await file.step()).toBeNull();
    expect(file.getSnapshot()).toEqual({
      status: "invalid",
      value: null,
      error: null,
    });
    expect(await file.step()).toBeNull();
    expect(s.requests.length).toBe(1);
  });

  test("a server error backs off from 2 s to 30 s, then reads the file", async () => {
    const s = server(
      Response.json({}, { status: 502 }),
      Response.json({}, { status: 500 }),
      Response.json({}, { status: 503 }),
      Response.json({}, { status: 503 }),
      Response.json({}, { status: 503 }),
      bytes("glb"),
    );
    const file = fileOn(s.fetch);
    const waits: (number | null)[] = [];
    for (let i = 0; i < 6; i++) waits.push(await file.step());
    expect(waits).toEqual([
      FILE_BACKOFF_MIN_MS,
      FILE_BACKOFF_MIN_MS * 2,
      FILE_BACKOFF_MIN_MS * 4,
      FILE_BACKOFF_MIN_MS * 8,
      FILE_BACKOFF_MAX_MS,
      null,
    ]);
    expect(file.getSnapshot()).toEqual({
      status: "ok",
      value: "glb",
      error: null,
    });
  });

  test("a failing read shows its error while it waits to retry", async () => {
    const s = server(Response.json({}, { status: 502 }));
    const file = fileOn(s.fetch);
    await file.step();
    expect(file.getSnapshot()).toEqual({
      status: "loading",
      value: null,
      error: {
        message: `${URL}: HTTP 502`,
        status: 502,
        retryAtMs: 1000 + FILE_BACKOFF_MIN_MS,
      },
    });
  });

  test("a dropped connection retries instead of reading as invalid", async () => {
    const s = server(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
        ),
      bytes("glb"),
    );
    const file = fileOn(s.fetch);
    expect(await file.step()).toBe(FILE_BACKOFF_MIN_MS);
    expect(file.getSnapshot().error?.status).toBeNull();
    expect(await file.step()).toBeNull();
    expect(file.getSnapshot().value).toBe("glb");
  });

  test("stop abandons the read in flight", async () => {
    const s = server(
      () =>
        new Promise<Response>((_, reject) => {
          queueMicrotask(() => {
            const signal = s.signals[0];
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        }),
    );
    const disposed: string[] = [];
    const file = fileOn(s.fetch, decode, disposed);
    file.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.signals.length).toBe(1);
    file.stop();
    expect(s.signals[0].aborted).toBe(true);
    expect(file.getSnapshot()).toEqual({
      status: "idle",
      value: null,
      error: null,
    });
    expect(disposed).toEqual([]);
  });

  test("stop lets the parsed file go; start reads it again", async () => {
    const s = server(bytes("glb"));
    const disposed: string[] = [];
    const file = fileOn(s.fetch, decode, disposed);
    await file.step();
    file.stop();
    expect(disposed).toEqual(["glb"]);
    expect(file.getSnapshot().status).toBe("idle");
    file.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(file.getSnapshot().value).toBe("glb");
    expect(s.requests.length).toBe(2);
    file.stop();
  });

  test("a file parsed after its layer was hidden is let go at once", async () => {
    let finish: (value: string) => void = () => {};
    const s = server(bytes("glb"));
    const disposed: string[] = [];
    const file = fileOn(
      s.fetch,
      () => new Promise<string>((resolve) => (finish = resolve)),
      disposed,
    );
    const pending = file.step();
    await new Promise((resolve) => setTimeout(resolve, 0));
    file.stop();
    finish("late");
    expect(await pending).toBeNull();
    expect(disposed).toEqual(["late"]);
    expect(file.getSnapshot().status).toBe("idle");
  });

  test("subscribers hear about changes only", async () => {
    const s = server(bytes("glb"));
    const file = fileOn(s.fetch);
    let calls = 0;
    file.subscribe(() => calls++);
    await file.step();
    // loading, then ok
    expect(calls).toBe(2);
    await file.step();
    expect(calls).toBe(2);
  });
});
