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

export const SLICES = 7;

export const glowVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vEye;
  void main() {
    vUv = uv;
    // The eye in the quad's own frame: x and y in field units (the quad is scaled to the field),
    // z in metres. Each stereo eye gets its own, so each sees its own parallax.
    vEye = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
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
    light *= smoothstep(0.0, 0.08, min(border.x, border.y));
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
