"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { sceneWithDefaults } from "@/lib/scene-presets";
import {
  Euler,
  Group,
  LoadingManager,
  Quaternion,
  Mesh,
  Texture,
  Material,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import {
  EMPTY_SCENE,
  IDENTITY_POSE,
  ROS_TO_RENDER,
  objectMatrix,
  parseScene,
  type Pose,
  type SceneDocument,
  type SceneObject,
  type Vec3,
} from "@/lib/scene";

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("custom-lerobot-scenes", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("scenes");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function storedScene(
  key: string,
  value?: SceneDocument,
): Promise<unknown> {
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        "scenes",
        value ? "readwrite" : "readonly",
      );
      const store = transaction.objectStore("scenes");
      const request = value ? store.put(value, key) : store.get(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error("Scene storage was interrupted."),
        );
    });
  } finally {
    db.close();
  }
}
export function useSceneWorkspace(
  scope: string,
  defaults: SceneDocument = EMPTY_SCENE,
) {
  const [state, setState] = useState<{
    scope: string;
    doc: SceneDocument;
    loaded: boolean;
  }>({ scope, doc: defaults, loaded: false });
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    let active = true;
    setStorageError("");
    storedScene(scope)
      .then((saved) => {
        if (active)
          setState({
            scope,
            doc: sceneWithDefaults(saved, defaults),
            loaded: true,
          });
      })
      .catch(() => {
        if (active) {
          setState({ scope, doc: defaults, loaded: true });
          setStorageError(
            "Browser storage is unavailable. Export your scene to keep it.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [scope, defaults]);
  const doc = state.scope === scope ? state.doc : defaults;
  const loaded = state.scope === scope && state.loaded;
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      storedScene(scope, doc).catch(() =>
        setStorageError(
          "Scene could not be saved in this browser. Export it to keep your changes.",
        ),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [scope, doc, loaded]);
  return {
    doc,
    loaded,
    storageError,
    setDoc: (next: SceneDocument) =>
      setState({ scope, doc: next, loaded: true }),
  };
}

function disposeModel(model: Group) {
  model.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry?.dispose();
    const materials: Material[] = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const material of materials) {
      for (const value of Object.values(material))
        if (value instanceof Texture) value.dispose();
      material.dispose();
    }
  });
}
async function loadGlb(dataUrl: string): Promise<Group> {
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) =>
    c.charCodeAt(0),
  );
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith("data:") && !url.startsWith("blob:"))
      throw new Error(
        "Use a self-contained GLB with embedded textures and buffers.",
      );
    return url;
  });
  const gltf = await new GLTFLoader(manager)
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(bytes.buffer, "");
  gltf.scene.traverse((child) => {
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return gltf.scene;
}
function ImportedModel({ dataUrl, name }: { dataUrl: string; name: string }) {
  const [model, setModel] = useState<Group | null>(null);
  const [error, setError] = useState(false);
  const { invalidate } = useThree();
  useEffect(() => {
    let active = true;
    let loaded: Group | undefined;
    setModel(null);
    setError(false);
    loadGlb(dataUrl)
      .then((result) => {
        loaded = result;
        if (active) {
          setModel(result);
          invalidate();
        } else disposeModel(result);
      })
      .catch(() => {
        if (active) {
          setError(true);
          invalidate();
        }
      });
    return () => {
      active = false;
      if (loaded) disposeModel(loaded);
    };
  }, [dataUrl, invalidate]);
  if (error)
    return (
      <Html center>
        <span role="alert" className="bg-surface-1 text-fg p-2 text-xs">
          Could not load {name}. Import a self-contained GLB.
        </span>
      </Html>
    );
  // Asset-local glTF Y-up becomes scene Z-up. User poses are always ROS coordinates.
  return model ? (
    <group rotation={[Math.PI / 2, 0, 0]}>
      <primitive object={model} />
    </group>
  ) : null;
}
// "robot" is the LeRobot replay; "clio" is the Clio episode viewer, whose origin
// is the calibrated table corner and which has no robot to place.
export type SceneVariant = "robot" | "clio";
export function SceneObjects({
  doc,
  displayScale,
  axes,
  variant = "robot",
}: {
  doc: SceneDocument;
  displayScale: number;
  axes: boolean;
  variant?: SceneVariant;
}) {
  const { invalidate } = useThree();
  useEffect(() => invalidate(), [doc, axes, displayScale, invalidate]);
  return (
    <group name="scene-objects" quaternion={ROS_TO_RENDER} scale={displayScale}>
      {axes && (
        <>
          <axesHelper args={[0.15]} />
          <Html position={[0, 0, 0]}>
            <span className="bg-surface-1 text-fg rounded px-1 text-[10px] whitespace-nowrap">
              {variant === "clio" ? "table corner" : "world (0, 0, 0)"}
            </span>
          </Html>
          <Html position={[0.17, 0, 0]}>
            <span className="text-red-500 text-xs font-semibold">X</span>
          </Html>
          <Html position={[0, 0.17, 0]}>
            <span className="text-green-500 text-xs font-semibold">Y</span>
          </Html>
          <Html position={[0, 0, 0.17]}>
            <span className="text-blue-500 text-xs font-semibold">Z</span>
          </Html>
        </>
      )}
      {doc.objects.map((object) => (
        <group
          key={object.id}
          matrix={objectMatrix(doc, object)}
          matrixAutoUpdate={false}
        >
          {object.geometry.type === "box" ? (
            <mesh castShadow receiveShadow>
              <boxGeometry args={object.geometry.size} />
              <meshStandardMaterial
                color={object.geometry.color}
                roughness={0.7}
              />
            </mesh>
          ) : (
            <ImportedModel
              dataUrl={object.geometry.dataUrl}
              name={object.name}
            />
          )}
        </group>
      ))}
    </group>
  );
}

const button = "btn";
const input =
  "w-full min-w-0 rounded bg-surface-2 text-fg px-2 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-accent";
function TripleInput({
  label,
  value,
  onChange,
  positive = false,
}: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
  positive?: boolean;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs text-fg-muted">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        {value.map((v, i) => (
          <label key={i} className="text-[10px] text-fg-muted">
            {["X", "Y", "Z"][i]}
            <input
              type="number"
              aria-label={`${label} ${["X", "Y", "Z"][i]}`}
              className={`${input} font-mono`}
              step="0.01"
              min={positive ? 0.001 : undefined}
              value={Number(v.toFixed(5))}
              onChange={(e) => {
                if (e.target.value === "") return;
                const n = Number(e.target.value);
                if (!Number.isFinite(n) || (positive && n <= 0)) return;
                onChange(value.map((old, j) => (j === i ? n : old)) as Vec3);
              }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function PoseInputs({
  value,
  onChange,
}: {
  value: Pose;
  onChange: (pose: Pose) => void;
}) {
  const euler = new Euler().setFromQuaternion(
    new Quaternion(...value.rotation),
    "XYZ",
  );
  const degrees: Vec3 = [euler.x, euler.y, euler.z].map(
    (v) => (v * 180) / Math.PI,
  ) as Vec3;
  return (
    <>
      <TripleInput
        label="Position (meters)"
        value={value.translation}
        onChange={(translation) => onChange({ ...value, translation })}
      />
      <TripleInput
        label="Rotation (degrees)"
        value={degrees}
        onChange={(v) => {
          const q = new Quaternion().setFromEuler(
            new Euler(...(v.map((n) => (n * Math.PI) / 180) as Vec3), "XYZ"),
          );
          onChange({ ...value, rotation: [q.x, q.y, q.z, q.w] });
        }}
      />
    </>
  );
}
export function SceneEditor({
  doc,
  setDoc,
  storageError,
  scope,
  defaults,
  variant = "robot",
}: {
  doc: SceneDocument;
  setDoc: (doc: SceneDocument) => void;
  storageError: string;
  scope: string;
  defaults: SceneDocument;
  variant?: SceneVariant;
}) {
  const clio = variant === "clio";
  // The robot variant falls back to the robot placement; the Clio variant has
  // none and falls back to the first prop.
  const none = clio ? "" : "base_link";
  const [selectedId, setSelectedId] = useState(none);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const currentDoc = useRef(doc);
  currentDoc.current = doc;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const selected =
    doc.objects.find((o) => o.id === selectedId) ??
    (clio ? doc.objects[0] : undefined);
  const base = doc.frames.find((f) => f.id === "base_link")!;
  const updateObject = (patch: Partial<SceneObject>) =>
    setDoc({
      ...doc,
      objects: doc.objects.map((o) =>
        o.id === selected?.id ? { ...o, ...patch } : o,
      ),
    });
  const frames = useMemo(
    () => ["world", ...doc.frames.map((f) => f.id)],
    [doc.frames],
  );
  const frameOptions = clio
    ? frames.filter((f) => f !== "base_link" || f === selected?.frame)
    : frames;
  async function importFile(file: File) {
    setError("");
    setBusy(true);
    try {
      if (file.size > 64_000_000)
        throw new Error("Scene files must be under 64 MB.");
      let next: SceneDocument;
      let select = none;
      if (file.name.toLowerCase().endsWith(".glb")) {
        if (file.size > 25_000_000)
          throw new Error("GLB files must be under 25 MB.");
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Could not read that file."));
          reader.onload = () =>
            resolve(
              String(reader.result).replace(
                /^data:[^;]*;/,
                "data:model/gltf-binary;",
              ),
            );
          reader.readAsDataURL(file);
        });
        const model = await loadGlb(dataUrl);
        disposeModel(model);
        select = crypto.randomUUID();
        next = parseScene({
          ...currentDoc.current,
          objects: [
            ...currentDoc.current.objects,
            {
              id: select,
              name: file.name.replace(/\.glb$/i, ""),
              frame: "world",
              ...IDENTITY_POSE,
              scale: [1, 1, 1],
              geometry: { type: "glb", dataUrl },
            },
          ],
        });
      } else if (file.name.toLowerCase().endsWith(".json"))
        next = parseScene(JSON.parse(await file.text()));
      else
        throw new Error("Choose a self-contained .glb model or .json scene.");
      if (mounted.current) {
        setDoc(next);
        setSelectedId(select);
      }
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : "Import failed. Check the file and try again.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function addBox() {
    const id = crypto.randomUUID();
    setDoc({
      ...doc,
      objects: [
        ...doc.objects,
        {
          id,
          name: "Box",
          frame: "world",
          ...IDENTITY_POSE,
          translation: [0.2, 0, 0.05],
          scale: [1, 1, 1],
          geometry: { type: "box", size: [0.1, 0.1, 0.1], color: "#d9a66f" },
        },
      ],
    });
    setSelectedId(id);
  }
  function exportScene() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scope.replaceAll("/", "-")}.scene.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <aside
      id="scene-editor"
      aria-label="Scene objects"
      className="scene-editor bg-surface-1 text-fg p-5 space-y-4 overflow-y-auto max-h-[40vh] lg:max-h-none lg:w-80 lg:shrink-0"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Scene objects</h2>
        <span className="text-[10px] text-fg-muted">Static layout</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? "Importing…" : "Import model or scene"}
        </button>
        <button
          className={button}
          disabled={busy || doc.objects.length >= 100}
          onClick={addBox}
        >
          Add box
        </button>
        <button className={button} disabled={busy} onClick={exportScene}>
          Export scene
        </button>
        {(!clio || defaults.preset) && (
          <button
            className={button}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                if (defaults.preset) {
                  setDoc(structuredClone(defaults));
                  setSelectedId(none);
                  return;
                }
                const response = await fetch("/examples/workcell.scene.json");
                if (!response.ok)
                  throw new Error("Could not load example scene.");
                const example = parseScene(await response.json());
                if (mounted.current) {
                  setDoc(example);
                  setSelectedId("base_link");
                }
              } catch (e) {
                if (mounted.current)
                  setError(
                    e instanceof Error ? e.message : "Could not load example.",
                  );
              } finally {
                if (mounted.current) setBusy(false);
              }
            }}
          >
            {defaults.preset ? "Reset demo scene" : "Load example"}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".glb,.json"
          className="hidden"
          aria-label="Import model or scene"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = "";
          }}
        />
      </div>
      {(error || storageError) && (
        <p role="alert" className="text-xs text-fg bg-surface-2 rounded p-2">
          {error || storageError}
        </p>
      )}
      {(!clio || selected) && (
        <label className="block text-xs text-fg-muted space-y-1">
          <span>Selected item</span>
          <select
            className={input}
            value={selected ? selected.id : "base_link"}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {!clio && <option value="base_link">Robot placement</option>}
            {doc.objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected ? (
        <>
          <label className="block text-xs text-fg-muted space-y-1">
            <span>Name</span>
            <input
              className={input}
              maxLength={200}
              value={selected.name}
              onChange={(e) =>
                updateObject({ name: e.target.value || "Object" })
              }
            />
          </label>
          <label className="block text-xs text-fg-muted space-y-1">
            <span>Position relative to</span>
            <select
              className={input}
              value={selected.frame}
              onChange={(e) => updateObject({ frame: e.target.value })}
            >
              {frameOptions.map((f) => (
                <option key={f} value={f}>
                  {f === "world"
                    ? clio
                      ? "Table corner"
                      : "Scene"
                    : f === "base_link"
                      ? "Robot"
                      : f}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs leading-relaxed text-fg-muted">
            Adjusts this static object’s placement and size.
          </p>
          <PoseInputs value={selected} onChange={updateObject} />
          <TripleInput
            label="Size multiplier"
            value={selected.scale}
            onChange={(scale) => updateObject({ scale })}
            positive
          />
          {selected.geometry.type === "box" && (
            <>
              <TripleInput
                label="Dimensions (m)"
                value={selected.geometry.size}
                positive
                onChange={(size) => {
                  if (selected.geometry.type === "box")
                    updateObject({ geometry: { ...selected.geometry, size } });
                }}
              />
              <label className="flex items-center justify-between text-xs text-fg-muted">
                Color
                <input
                  type="color"
                  aria-label="Object color"
                  value={selected.geometry.color}
                  onChange={(e) => {
                    if (selected.geometry.type === "box")
                      updateObject({
                        geometry: {
                          ...selected.geometry,
                          color: e.target.value,
                        },
                      });
                  }}
                />
              </label>
            </>
          )}
          <button
            className={button}
            onClick={() => {
              setDoc({
                ...doc,
                objects: doc.objects.filter((o) => o.id !== selected.id),
              });
              setSelectedId(none);
            }}
          >
            Remove object
          </button>
        </>
      ) : clio ? null : (
        <>
          <p className="text-xs text-fg-muted">
            Moves and rotates the whole robot. Joint motion comes from the
            recording.
          </p>
          <PoseInputs
            value={base}
            onChange={(next) =>
              setDoc({
                ...doc,
                frames: doc.frames.map((f) =>
                  f.id === "base_link" ? { ...f, ...next } : f,
                ),
              })
            }
          />
        </>
      )}
      <details className="text-xs text-fg-muted">
        <summary className="cursor-pointer text-fg">
          Coordinates and files
        </summary>
        <div className="mt-2 space-y-2">
          {clio ? (
            <>
              <p>
                Origin is the calibrated table corner. X points away from the
                learner, Y left, Z up.
              </p>
              <p>
                Props added here are static. Tracked objects come from the
                recording.
              </p>
            </>
          ) : (
            <p>
              World origin is (0, 0, 0). X forward, Y left, Z up. Grid cells are
              0.1 m.{" "}
              {doc.originDescription ??
                "The scene file places the robot root relative to world."}
            </p>
          )}
          <p>
            Import a .glb model to add an object, or a .json scene to replace
            the layout. GLB files must include their textures and buffers. A
            size multiplier of 1 keeps the original size.
          </p>
          {clio ? (
            <p>
              Position is in meters. Rotation is about X, Y and Z in degrees.
              Changes save in this browser; the recording is unchanged. Export
              the scene to keep a copy.
            </p>
          ) : (
            <p>
              Position is in meters. Rotation is about X, Y and Z in degrees.
              Robot placement is relative to {base.parent}. Changes save in this
              browser per dataset; the original dataset is unchanged. Export the
              scene to keep a copy.
            </p>
          )}
          {!clio && (
            <a
              className="text-accent-fg underline"
              href={
                defaults.preset
                  ? "/examples/g1-blockstacking.scene.json"
                  : "/examples/workcell.scene.json"
              }
              download
            >
              Download example scene
            </a>
          )}
        </div>
      </details>
    </aside>
  );
}
