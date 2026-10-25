import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  type MeshBasicMaterial,
  type MeshLambertMaterial,
  RedFormat,
  RepeatWrapping,
  type Texture,
  UnsignedByteType,
} from "three";
import { GRAIN_SIZE, grainPixels } from "@/lib/clio/solid-surfaces";

// The solid look of context surfaces (DESIGN.md, "Room scan"): the room scan's walls, floor and
// furniture, the detected raised planes and the table top. Opaque, with a fine matte grain
// (solid-surfaces.ts) laid on in world space from the three axes and blended by the face's
// facing, so walls, floors and tops take it without texture coordinates and it runs on across
// meshes. Surfaces drawn on the backdrop layer also write their depth a little behind where they
// are (DEPTH_BIAS_M along the view ray, so the picture is unchanged): context drawn over them, such
// as the grid on a scanned table or the floor grid on a scanned floor, still shows when it is that
// close in front of or behind them, while a wall hides what lies beyond it.

/** Meters of surface one grain image covers. */
export const GRAIN_TILE_M = 0.8;
/** How far behind itself a backdrop surface writes its depth, in meters. */
export const DEPTH_BIAS_M = 0.03;

let pixels: Uint8Array | null = null;

/** A new texture of the grain (the pixels are made once a session); its owner disposes it. */
export function grainTexture(): DataTexture {
  pixels ??= grainPixels();
  const texture = new DataTexture(
    pixels,
    GRAIN_SIZE,
    GRAIN_SIZE,
    RedFormat,
    UnsignedByteType,
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // The floor is mostly seen at a slant.
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

const WORLD_VERTEX = /* glsl */ `#include <project_vertex>
vSolidWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`;

// Moves the depth (only) of each vertex DEPTH_BIAS_M further along its view ray.
const BIAS_VERTEX = /* glsl */ `
{
  vec4 solidFar = mvPosition;
  solidFar.xyz *= 1.0 + ${DEPTH_BIAS_M.toFixed(3)} / max(length(mvPosition.xyz), 1e-3);
  vec4 solidClip = projectionMatrix * solidFar;
  gl_Position.z = solidClip.z / solidClip.w * gl_Position.w;
}`;

// The face's own normal (from the screen derivatives, as flat shading does) weights the three
// projections, so each face takes the grain from the axis it faces.
const GRAIN_FRAGMENT = /* glsl */ `#include <map_fragment>
{
  vec3 solidNormal = normalize(cross(dFdx(vSolidWorld), dFdy(vSolidWorld)));
  vec3 solidWeight = pow(abs(solidNormal), vec3(4.0));
  solidWeight /= solidWeight.x + solidWeight.y + solidWeight.z;
  vec3 solidAt = vSolidWorld / ${GRAIN_TILE_M.toFixed(3)};
  diffuseColor.rgb *= texture2D(solidGrain, solidAt.zy).r * solidWeight.x
    + texture2D(solidGrain, solidAt.xz).r * solidWeight.y
    + texture2D(solidGrain, solidAt.xy).r * solidWeight.z;
}`;

/** The program cache key of a solid material, with and without the depth bias. */
export const SOLID_PROGRAM = {
  biased: "clio-solid-biased",
  plain: "clio-solid",
} as const;

/**
 * Gives `material` the solid look: `grain` laid on in world space and, with `depthBias`, its depth
 * written DEPTH_BIAS_M behind it. The material keeps everything else (color, lighting, sides).
 */
export function solidLook(
  material: MeshLambertMaterial | MeshBasicMaterial,
  grain: Texture,
  { depthBias }: { depthBias: boolean },
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.solidGrain = { value: grain };
    shader.vertexShader =
      `varying vec3 vSolidWorld;\n${shader.vertexShader}`.replace(
        "#include <project_vertex>",
        depthBias ? `${WORLD_VERTEX}${BIAS_VERTEX}` : WORLD_VERTEX,
      );
    shader.fragmentShader =
      `uniform sampler2D solidGrain;\nvarying vec3 vSolidWorld;\n${shader.fragmentShader}`.replace(
        "#include <map_fragment>",
        GRAIN_FRAGMENT,
      );
  };
  const key = depthBias ? SOLID_PROGRAM.biased : SOLID_PROGRAM.plain;
  material.customProgramCacheKey = () => key;
}
