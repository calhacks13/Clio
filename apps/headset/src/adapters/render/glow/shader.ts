import { depthChunk, INTERIOR_POINTS } from './depth-occlusion';

// The object's light, drawn on one quad around its silhouette. All of its softness is computed
// here from the signed distance field (HighlightMask): nothing is blurred on the CPU.
//
// The light is a thin volume, not a flat decal. Each eye's ray through the quad crosses SLICES
// copies of the silhouette from `thickness` behind the outline's plane to a little in front of it
// and adds up what they emit, so the two eyes see the glow at slightly different places (parallax)
// and from an angle its edge thickens like a lit solid. Each slice emits
//   - a rim: a band of light hugging the boundary, peaking just inside it and wide enough
//     (`edge`) that a mask a few pixels off still sits inside the band;
//   - a body: faint inner light that fades inward from the rim, so the object looks lit from
//     within, densest at its skin, while its own markings stay readable;
//   - a bloom: a tight gaussian plus a long exponential tail outside the boundary, like light
//     scattering into the room. Deeper slices bloom wider, as light from inside an object would.
// The light gets bluer and deeper as it falls off and lighter where it is strongest, as emitted
// light does. Output is premultiplied with alpha below the emitted colour, so over passthrough it
// mostly adds light (and only slightly dims what is behind the bloom).
//
// It keeps the room's depth order: hands' occluders (depth only) hide it through the depth test,
// and with a depth map (GLOW_DEPTH, glow/depth-occlusion.ts) a real surface nearer than the
// object's own front by more than a margin fades it out: the vertex shader finds that front from
// the map at points inside the silhouette, then each fragment blends the tests of the nearest
// texels. Reads nearer than the sensor's reliable range count as unknown, and the test fades out
// as the glow comes within reach of that range, so a learner leaning in never loses the light.

export const SLICES = 7;

export const glowVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vEye;
  varying vec3 vWorld;
  #if GLOW_DEPTH > 0
    ${depthChunk}
    uniform vec2 interior[${INTERIOR_POINTS}];
    uniform int interiorCount;
    uniform float maxFront;
    uniform float occlusionPlane;
    // How far the object's own front is in front of this plane (m), for this eye and frame...
    flat varying float vFront;
    // ...and its surface as a tilted plane: front ~ x + y (u - 0.5) + z (v - 0.5) in the quad's uv.
    flat varying vec3 vSurface;
  #endif
  void main() {
    vUv = uv;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    // The eye in the quad's own frame: x and y in field units (the quad is scaled to the field),
    // z in metres. Each stereo eye gets its own, so each sees its own parallax.
    vEye = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    #if GLOW_DEPTH > 0
      // The object's front: the second-largest gap at the points inside the silhouette (about the
      // 10th percentile of their real depth), never behind the plane, capped by its size. Four
      // vertices per eye; the same in each (glowOcclusion / objectFront mirror this in TS).
      float first = 0.0;
      float second = 0.0;
      int valid = 0;
      // Least squares for the plane: sums of 1, u, v, uu, uv, vv, g, ug, vg (u, v centred).
      float n = 0.0, su = 0.0, sv = 0.0, suu = 0.0, suv = 0.0, svv = 0.0;
      float sg = 0.0, sug = 0.0, svg = 0.0;
      for (int i = 0; i < ${INTERIOR_POINTS}; i++) {
        if (i >= interiorCount) break;
        float gap = depthGap((modelMatrix * vec4(interior[i] - 0.5, 0.0, 1.0)).xyz);
        if (gap <= NO_DEPTH) continue;
        valid++;
        float g = max(gap, 0.0);
        vec2 c = interior[i] - 0.5;
        n += 1.0; su += c.x; sv += c.y;
        suu += c.x * c.x; suv += c.x * c.y; svv += c.y * c.y;
        sg += g; sug += c.x * g; svg += c.y * g;
        if (g > first) {
          second = first;
          first = g;
        } else if (g > second) {
          second = g;
        }
      }
      vFront = min(valid >= 2 ? second : first, maxFront);
      // An object's surface is rarely at one depth (a laptop's lid leans toward you, its corners
      // are nearer than its middle), so where the points allow, fit a plane to their gaps and let
      // each fragment use whichever is further forward: the plane there or vFront. Solved by
      // Cramer's rule; too few points or a degenerate spread keeps the single depth.
      vSurface = vec3(vFront, 0.0, 0.0);
      float det = n * (suu * svv - suv * suv) - su * (su * svv - suv * sv) + sv * (su * suv - suu * sv);
      if (occlusionPlane > 0.5 && valid >= 6 && abs(det) > 1e-7) {
        float a = (sg * (suu * svv - suv * suv) - su * (sug * svv - suv * svg) + sv * (sug * suv - suu * svg)) / det;
        float b = (n * (sug * svv - suv * svg) - sg * (su * svv - suv * sv) + sv * (su * svg - sug * sv)) / det;
        float c = (n * (suu * svg - sug * suv) - su * (su * svg - sug * sv) + sg * (su * suv - suu * sv)) / det;
        vSurface = vec3(a, b, c);
      }
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const glowFragmentShader = /* glsl */ `
  uniform sampler2D field;
  uniform vec3 color;
  uniform float opacity;
  uniform float size;
  uniform float edge;
  uniform float halo;
  uniform float thickness;
  uniform float spill;
  uniform float breath;
  uniform float ignite;
  varying vec2 vUv;
  varying vec3 vEye;

  const int SLICES = ${SLICES};

  // GLOW_DEPTH (a define): 0 no depth map, 1 a texture array (a layer per eye), 2 a plain texture.
  varying vec3 vWorld;
  #if GLOW_DEPTH > 0
    ${depthChunk}
    uniform float occlusionOn;
    uniform float occlusionMargin;
    uniform float occlusionFalloff;
    uniform int vizMode;
    uniform float occlusionFilter;
    uniform float occlusionSoftness;
    uniform float occlusionNearOff;
    uniform float occlusionNearOn;
    uniform float maxFront;
    flat varying float vFront;
    flat varying vec3 vSurface;

    // How much of the test applies at planar depth z (m): none up close, where the map cannot be
    // trusted, all of it from occlusionNearOn (nearFade in TS).
    float nearFade(float z) {
      return smoothstep(occlusionNearOff, occlusionNearOn, z);
    }

    // The object's own front at this point of the quad (m in front of the plane): the fitted
    // plane where it is further forward than the single depth, within [0, maxFront].
    float frontAt(vec2 uv) {
      float planeFront = vSurface.x + vSurface.y * (uv.x - 0.5) + vSurface.z * (uv.y - 0.5);
      return max(vFront, clamp(planeFront, 0.0, maxFront));
    }

    // One texel's test: a real surface nearer than the object's front by more than the margin.
    float texelHidden(ivec2 p, float glow, float front) {
      float real = realDepthAt(p);
      if (real <= 0.0) return 0.0;
      return smoothstep(occlusionMargin, occlusionMargin + occlusionFalloff, glow - real - front);
    }

    // Hidden (0..1), smooth at the edges: the depth map is coarse (320 texels across the view on
    // Quest), so the nearest texels' tests are blended and the blend is cut a little past one
    // half over a narrow band, keeping the edge tight to what is in front (a wide band reads as a
    // halo around a hand). 'cubic' blends 4 x 4 texels with cubic B-spline weights, whose
    // contours are curvature-continuous: no texel shows. 'smooth' blends 3 x 3 with quadratic
    // B-spline weights (round, faint texel ripples); 'bilinear' 2 x 2, as percentage-closer
    // filtering does for shadow maps (texel corners show).
    float occlusion(vec3 world, float front) {
      if (occlusionOn < 0.5) return 0.0;
      vec3 t = depthTexel(world);
      if (t.z <= 0.0) return 0.0;
      float near = nearFade(t.z);
      if (near <= 0.0) return 0.0;
      float h = 0.0;
      if (occlusionFilter < 0.5) {
        vec2 f = t.xy - 0.5;
        ivec2 p = ivec2(floor(f)) - 1;
        vec2 u = fract(f);
        vec2 u2 = u * u;
        vec2 u3 = u2 * u;
        vec2 w0 = (1.0 - 3.0 * u + 3.0 * u2 - u3) / 6.0;
        vec2 w1 = (4.0 - 6.0 * u2 + 3.0 * u3) / 6.0;
        vec2 w2 = (1.0 + 3.0 * u + 3.0 * u2 - 3.0 * u3) / 6.0;
        vec2 w3 = u3 / 6.0;
        for (int j = 0; j < 4; j++) {
          float wy = j == 0 ? w0.y : j == 1 ? w1.y : j == 2 ? w2.y : w3.y;
          for (int i = 0; i < 4; i++) {
            float wx = i == 0 ? w0.x : i == 1 ? w1.x : i == 2 ? w2.x : w3.x;
            h += wx * wy * texelHidden(p + ivec2(i, j), t.z, front);
          }
        }
      } else if (occlusionFilter > 1.5) {
        vec2 f = t.xy - 0.5;
        ivec2 p = ivec2(floor(f));
        vec2 w = fract(f);
        float a = texelHidden(p, t.z, front);
        float b = texelHidden(p + ivec2(1, 0), t.z, front);
        float c = texelHidden(p + ivec2(0, 1), t.z, front);
        float d = texelHidden(p + ivec2(1, 1), t.z, front);
        h = mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
      } else {
        ivec2 p = ivec2(floor(t.xy));
        vec2 s = fract(t.xy) - 0.5;
        vec2 lo = 0.5 * (0.5 - s) * (0.5 - s);
        vec2 mid = 0.75 - s * s;
        vec2 hi = 0.5 * (0.5 + s) * (0.5 + s);
        for (int j = -1; j <= 1; j++) {
          float wy = j < 0 ? lo.y : j > 0 ? hi.y : mid.y;
          for (int i = -1; i <= 1; i++) {
            float wx = i < 0 ? lo.x : i > 0 ? hi.x : mid.x;
            h += wx * wy * texelHidden(p + ivec2(i, j), t.z, front);
          }
        }
      }
      return smoothstep(0.55 - occlusionSoftness, 0.55 + occlusionSoftness, h) * near;
    }
  #endif

  // The field holds distance / size in one half-float channel, filtered linearly.
  float distanceAt(vec2 uv) {
    return texture2D(field, uv).r * size;
  }

  // Light emitted at signed distance d (metres, positive inside) by one slice.
  float emission(float d, float w, float h, float depth) {
    float outside = max(-d, 0.0);
    float inner = smoothstep(-w, w, d);
    // pow() is undefined for a negative base in GLSL: square by hand.
    float r = (d - 0.4 * w) / w;
    float rim = exp(-0.5 * r * r);
    float body = inner * (0.07 + 0.2 * exp(-max(d, 0.0) / (3.0 * w)));
    float spread = h * (1.0 + 0.7 * depth);
    float near = outside / (0.5 * spread);
    float bloom = (1.0 - inner) * spill *
      (0.42 * exp(-0.5 * near * near) + 0.3 * exp(-outside / spread));
    return 0.6 * rim + body + bloom;
  }

  void main() {
    float hidden = 0.0;
    #if GLOW_DEPTH > 0
      if (vizMode == 2) {
        // window.__occlusion.setViz('diff'): how the real surface compares with the object's
        // front here. Green: the object itself (kept); red: in front (hidden); blue: behind;
        // yellow: too near for the test (it is off); nothing: no read to trust.
        vec3 at = depthTexel(vWorld);
        if (at.z > 0.0 && nearFade(at.z) < 0.5) {
          gl_FragColor = vec4(vec3(1.0, 0.85, 0.1) * 0.5, 0.5);
          return;
        }
        float gap = depthGap(vWorld);
        if (gap <= NO_DEPTH) discard;
        float rel = gap - frontAt(vUv);
        vec3 tint = rel > occlusionMargin ? vec3(1.0, 0.15, 0.1)
          : rel < -occlusionMargin ? vec3(0.1, 0.3, 1.0) : vec3(0.1, 1.0, 0.3);
        gl_FragColor = vec4(tint * 0.5, 0.5);
        return;
      }
      hidden = occlusion(vWorld, frontAt(vUv));
    #endif
    if (hidden >= 0.999) discard;
    vec3 ray = vec3(vUv - 0.5, 0.0) - vEye;
    vec2 slope = ray.xy / min(ray.z, -1e-4);
    float swell = 1.0 + 0.5 * ignite + 0.1 * breath;
    float w = edge * (1.0 + 0.3 * ignite);
    float h = halo * swell;
    float light = 0.0;
    float weights = 0.0;
    for (int i = 0; i < SLICES; i++) {
      // From thickness behind the plane (depth 1) to a quarter of it in front (depth -0.25).
      float depth = 1.0 - 1.25 * float(i) / float(SLICES - 1);
      float z = -depth * thickness;
      float weight = 1.0 - 0.45 * max(depth, 0.0);
      light += emission(distanceAt(vUv + slope * z), w, h, max(depth, 0.0)) * weight;
      weights += weight;
    }
    light /= weights;
    float d = distanceAt(vUv);
    float inner = smoothstep(-w, w, d);
    // Breathing and the flare when an object is found.
    light *= (0.86 + 0.14 * breath) * (1.0 + 0.6 * ignite);
    // Never a hard quad edge, however far the bloom reaches.
    vec2 border = min(vUv, 1.0 - vUv);
    light *= smoothstep(0.0, 0.08, min(border.x, border.y)) * (1.0 - hidden);
    float energy = (1.0 - exp(-1.6 * light)) * opacity;
    vec3 deep = color * vec3(0.3, 0.62, 1.0);
    vec3 bright = mix(color, vec3(1.0), 0.08);
    vec3 tint = mix(deep, bright, smoothstep(0.05, 0.75, energy));
    // Emitted light: alpha below the colour, so it adds to the scene instead of painting over it.
    gl_FragColor = vec4(tint, energy * mix(0.3, 0.75, inner));
    #include <colorspace_fragment>
    gl_FragColor.rgb *= energy;
    // Half a step of interleaved-gradient noise breaks 8-bit bands in the long bloom; none where
    // there is no light, so the quad never shows.
    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float dither = (noise - 0.5) / 255.0 * min(1.0, energy * 64.0);
    gl_FragColor = max(gl_FragColor + vec4(vec3(dither), dither * 0.5), 0.0);
  }
`;
