"use client";

import React, { useState } from "react";
import {
  formatCount,
  formatExtent,
  formatShape,
} from "@/lib/clio/compiled-objects";
import { inspectObject, type InspectorRow } from "@/lib/clio/lanes";
import { drawnObjects, identityColor, themed } from "@/lib/clio/object-display";
import { modelRows } from "@/lib/clio/scene-display";
import type { SceneModel, ShapesDoc, TracksDoc } from "@clio/protocol";
import type { Capture } from "@clio-viewer/capture/model";
import { useTheme } from "@/utils/theme";

// One object at the viewed time: its newest update's source and estimate type,
// how long ago it was (derived), measured confidence only when there is one,
// held state and the newest detector answer. Inferred values are muted with a
// dashed underline, as inferred marks are dashed in the lanes. A compiled
// episode adds the object's estimated size and measured shape, each only when
// the compile has it. When the rebuilt scene made a model of the object, a
// "Model (generated)" block follows: how it was made, which measurement sized
// and turned it, the keyframe crop it was made from and its note. Generated
// values are muted with a dotted underline, a look of their own (DESIGN.md).

const VALUE_CLASS: Record<InspectorRow["basis"], string> = {
  measured: "text-fg-soft",
  derived: "text-fg-muted",
  inferred:
    "text-fg-muted underline decoration-dashed decoration-1 underline-offset-4",
  generated:
    "text-fg-muted underline decoration-dotted decoration-1 underline-offset-4",
};

export interface ObjectInspectorProps {
  capture: Capture;
  /** The object shown, or null for none. */
  entityId: string | null;
  tUs: number;
  /** The episode records location flags, so a lost position can show. */
  flagsRecorded: boolean;
  /** The compiled object series, for the estimated size. */
  tracks?: TracksDoc | null;
  /** The compiled shapes, for the measured shape. */
  shapes?: ShapesDoc | null;
  /** The object's generated model from the rebuilt scene, if it has one. */
  model?: SceneModel | null;
  /** The URL of a scene file (a crop), through the proxy; null shows no crop. */
  sceneFileUrl?: (name: string) => string | null;
  className?: string;
}

/**
 * What the compile measured of the object: its extent (the median of the
 * finder's boxes at the tracked depth: arithmetic on measured values, so
 * derived) and its fused depth samples (measured). Nothing for an object the
 * compile has no size or shape for.
 */
function compiledRows(
  entityId: string,
  tracks: TracksDoc | null,
  shapes: ShapesDoc | null,
): InspectorRow[] {
  const rows: InspectorRow[] = [];
  const extent = tracks?.objects.find((o) => o.id === entityId)?.extent;
  if (extent) {
    rows.push({
      label: "Size (estimated)",
      value: formatExtent(extent),
      basis: "derived",
      title: `Width and height across the camera, the median of ${formatCount(extent.samples)} measured boxes at the tracked depth`,
    });
  }
  const shape = shapes?.objects.find((o) => o.id === entityId);
  if (shape && shape.frames > 0) {
    rows.push({
      label: "Shape (measured)",
      value: formatShape(shape),
      basis: "measured",
      title: `${formatCount(shape.samples)} depth samples, fused relative to the tracked position`,
    });
  }
  return rows;
}

export default function ObjectInspector({
  capture,
  entityId,
  tUs,
  flagsRecorded,
  tracks = null,
  shapes = null,
  model = null,
  sceneFileUrl,
  className = "",
}: ObjectInspectorProps) {
  const theme = useTheme();
  const inspection = entityId
    ? inspectObject(capture, entityId, tUs, { flagsRecorded })
    : null;
  if (!inspection) {
    return (
      <section
        className={`text-sm text-fg-muted ${className}`}
        aria-label="Object"
      >
        Select an object
      </section>
    );
  }
  const index = drawnObjects(capture).findIndex((e) => e.id === entityId);
  const rows = [
    ...inspection.rows,
    ...compiledRows(inspection.entityId, tracks, shapes),
  ];
  const generated = model && model.id === inspection.entityId ? model : null;
  const crop = generated?.crops[0]?.file;
  const cropUrl = crop ? (sceneFileUrl?.(crop) ?? null) : null;
  return (
    <section
      className={`flex min-w-0 flex-col gap-3 ${className}`}
      aria-label={`Object ${inspection.label}`}
    >
      <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
        {index >= 0 && (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: themed(identityColor(index), theme) }}
            aria-hidden="true"
          />
        )}
        <span className="truncate" title={inspection.label}>
          {inspection.label}
        </span>
      </h3>
      <Rows rows={rows} />
      {generated && (
        <div
          className="flex min-w-0 flex-col gap-2 border-t border-line-subtle pt-3"
          aria-label="Generated model"
        >
          <Rows rows={modelRows(generated)} />
          {cropUrl && (
            <Crop key={cropUrl} src={cropUrl} label={generated.label} />
          )}
        </div>
      )}
    </section>
  );
}

function Rows({ rows }: { rows: InspectorRow[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map((row) =>
        row.label === null ? (
          <dd
            key={row.value}
            className={`col-span-2 ${VALUE_CLASS[row.basis]}`}
            title={row.title}
          >
            {row.value}
          </dd>
        ) : (
          <React.Fragment key={row.label}>
            <dt className="text-fg-faint">{row.label}</dt>
            <dd
              className={`min-w-0 truncate ${row.label === "Position" ? "whitespace-pre font-mono text-xs leading-5" : "tabular"} ${VALUE_CLASS[row.basis]}`}
              title={row.title}
            >
              {row.value}
            </dd>
          </React.Fragment>
        ),
      )}
    </dl>
  );
}

/** The keyframe crop a model was made from; nothing when it cannot be read. */
function Crop({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // A local file through the proxy, never optimized or cached.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`Keyframe crop of ${label} the model was made from`}
      title="Keyframe crop the model was made from"
      onError={() => setFailed(true)}
      className="h-24 w-32 rounded-lg bg-fill object-cover"
    />
  );
}
