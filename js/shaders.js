// All GLSL sources (WebGL2 / GLSL ES 3.00). The main "uber" shader handles glTF PBR materials,
// instanced foliage (wind), terrain and road variants through #defines.

// Output stage. Normal pipeline writes linear HDR into an offscreen buffer (tone-mapped later by COMPOSITE_FS).
// LITE (mobile) pipeline tone-maps + grades right in the object shaders and draws straight to the screen.
const OUT_GLSL = /* glsl */ `
#ifdef LITE
uniform vec4 uGradeA;      // x exposure, y saturation, z contrast, w flash amount
uniform vec3 uGradeGain;
uniform vec3 uGradeLift;
uniform vec3 uFlashRGB;
vec3 liteOut(vec3 c) {
  c = c * uGradeA.x + uFlashRGB * uGradeA.w;
  c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uGradeA.y);
  c = c * uGradeGain + uGradeLift * (1.0 - c);
  c = (c - 0.5) * uGradeA.z + 0.5;
  return pow(clamp(c, 0.0, 1.0), vec3(0.4545));
}
#define OUTC(c) liteOut(c)
#else
#define OUTC(c) ((c) * uOutScale)
#endif
`;

export const UBER_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aColor;
#ifdef INSTANCED
layout(location=5) in vec4 iA; // xyz = position, w = scale
layout(location=6) in vec4 iB; // x = yaw, y/z = lean, w = seed
#endif
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMat;
uniform float uTime;
uniform vec3 uWind;     // xy = direction, z = strength
uniform float uTreeH;   // tree height in model units (for sway/AO)
out vec3 vWorld;
out vec3 vN;
out vec2 vUV;
out vec4 vColor;
out float vAO;
void main() {
  vec3 p = aPos;
  vec3 n = aNormal;
  vAO = 1.0;
#ifdef INSTANCED
  float s = iA.w;
  float h = clamp(aPos.y / uTreeH, 0.0, 1.0);
  float sway = h * h;
  float ph = uTime * 1.25 + iB.w * 6.2831 + iA.x * 0.045 + iA.z * 0.037;
  float gust = sin(ph) * 0.6 + sin(ph * 2.31 + 1.7) * 0.25 + 0.55;
  p.xz += uWind.xy * (gust * uWind.z * sway * uTreeH * 0.035);
  #ifdef FOLIAGE
  float fl = uWind.z * sway * uTreeH * 0.012;
  p += vec3(sin(ph * 4.1 + aPos.x * 2.7), sin(ph * 3.3 + aPos.y * 1.9) * 0.5, cos(ph * 4.7 + aPos.z * 2.3)) * fl;
  #endif
  p.xz += iB.yz * p.y;
  float cy = cos(iB.x), sy = sin(iB.x);
  mat3 R = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  vec3 wp = R * (p * s) + iA.xyz;
  vN = R * n;
  vAO = mix(0.42, 1.0, pow(h, 0.65));
#else
  vec3 wp = (uModel * vec4(p, 1.0)).xyz;
  vN = uNormalMat * n;
#endif
  vWorld = wp;
  vUV = aUV;
  vColor = aColor;
  gl_Position = uViewProj * vec4(wp, 1.0);
}
`;

export const UBER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DShadow;
precision highp samplerCube;
in vec3 vWorld;
in vec3 vN;
in vec2 vUV;
in vec4 vColor;
in float vAO;
out vec4 outColor;

uniform vec4 uBaseColor;
uniform vec2 uMR;
uniform vec3 uEmissive;
uniform float uAlphaCutoff;
uniform float uNormalScale;
uniform float uOccStrength;
uniform vec4 uPaint;          // x hue shift (rad), y sat mul, z val mul, w enabled
uniform float uEmissiveBoost;
uniform float uMipBoost;
uniform float uWet;
uniform float uOutScale;
${OUT_GLSL}

uniform sampler2D uTexBase;
uniform sampler2D uTexNormal;
uniform sampler2D uTexMR;
uniform sampler2D uTexOcc;
uniform sampler2D uTexEmis;
uniform samplerCube uEnvSpec;
uniform sampler2DShadow uShadowMap;
uniform sampler2D uTexA; // terrain grass / road albedo
uniform sampler2D uTexB; // terrain floor / road detail
uniform sampler2D uTexC; // terrain rock

uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uEnvMaxLod;
uniform float uAmbLod;
uniform float uEnvIntensity;
uniform vec3 uAmbientTint;
uniform mat4 uShadowMat;
uniform vec4 uShadowParams; // x texel(uv), y normal bias (world), z depth bias, w filter radius (texels)
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform float uFogDensity;
uniform vec2 uFogHeight;
uniform int uNumSpots;
uniform vec4 uSpotPos[4];
uniform vec4 uSpotDir[4];
uniform vec4 uSpotColor[4];

const float PI = 3.14159265359;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

const vec2 POISSON[12] = vec2[12](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
  vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
  vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));

float shadowFactor(vec3 wp, vec3 N) {
#ifdef NO_SHADOW
  return 1.0;
#else
  vec3 p = wp + N * uShadowParams.y;
  vec4 sc = uShadowMat * vec4(p, 1.0);
  vec3 q = sc.xyz * 0.5 + 0.5;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0 || q.z > 1.0) return 1.0;
  float ang = hash12(gl_FragCoord.xy) * 6.2831853;
  float cs = cos(ang), sn = sin(ang);
  mat2 rot = mat2(cs, sn, -sn, cs);
  float sum = 0.0;
  for (int i = 0; i < SHADOW_TAPS; i++) {
    vec2 o = rot * POISSON[i] * uShadowParams.x * uShadowParams.w;
    sum += texture(uShadowMap, vec3(q.xy + o, q.z - uShadowParams.z));
  }
  float s = sum / float(SHADOW_TAPS);
  float edge = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y));
  return mix(1.0, s, smoothstep(0.0, 0.06, edge));
#endif
}

float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / (gv + gl + 1e-5);
}
vec3 F_Schlick(vec3 F0, float VoH) {
  return F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
}

#ifdef TERRAIN
vec3 terrainSurface(vec3 wp, vec3 N, vec4 w, out float rough, out float height) {
  vec2 uv = wp.xz;
#ifdef LITE
  // cheap: 4 texture reads, no noise, no bump
  vec4 g = texture(uTexA, uv * 0.21);
  vec4 g2 = texture(uTexA, uv * 0.037 + 0.31);
  vec4 f = texture(uTexB, uv * 0.19);
  vec4 r = texture(uTexC, uv * 0.16);
  float tw = w.r + w.g + w.b + w.a + 1e-4;
  vec3 col = (g.rgb * w.r + f.rgb * w.g + r.rgb * w.b + r.rgb * vec3(1.15, 1.08, 0.98) * w.a) / tw;
  col *= 0.72 + 0.56 * g2.a;
  height = 0.0;
  rough = 0.93;
  return col;
#else
  vec4 g = texture(uTexA, uv * 0.21) * 0.6 + texture(uTexA, uv * 0.037 + 0.31) * 0.4;
  vec4 f = texture(uTexB, uv * 0.19) * 0.6 + texture(uTexB, uv * 0.041 + 0.17) * 0.4;
  vec4 r = texture(uTexC, uv * 0.16) * 0.6 + texture(uTexC, uv * 0.033 + 0.53) * 0.4;
  vec4 gr = texture(uTexC, uv * 0.9);
  float tw = w.r + w.g + w.b + w.a + 1e-4;
  vec3 col = (g.rgb * w.r + f.rgb * w.g + r.rgb * w.b + gr.rgb * vec3(1.15, 1.08, 0.98) * w.a) / tw;
  height = (g.a * w.r + f.a * w.g + r.a * w.b + gr.a * w.a) / tw;
  float macro = 0.78 + 0.5 * vnoise(uv * 0.011) + 0.0 * vnoise(uv * 0.07);
  col *= macro;
  rough = 0.93;
  return col;
#endif
}
#endif

#ifdef ROAD
vec3 roadSurface(vec2 ruv, vec3 wp, out float rough, out float height, out float mark) {
  vec4 rt = texture(uTexA, ruv);
  vec4 d1 = texture(uTexB, wp.xz * 0.55);
#ifdef LITE
  vec3 col = rt.rgb * (0.82 + 0.34 * d1.r);
  height = d1.a * 0.8;
#else
  vec4 d2 = texture(uTexB, wp.xz * 0.07 + 0.5);
  vec3 col = rt.rgb * (0.82 + 0.34 * d1.r) * (0.9 + 0.2 * d2.g);
  height = d1.a * 0.8 + d2.a * 0.25;
#endif
  float isMark = smoothstep(0.86, 0.94, rt.a);
  rough = mix(clamp(rt.a * (0.8 + 0.4 * d1.g), 0.05, 1.0), 0.42, isMark);
  mark = isMark;
  return col;
}
#endif

// screen-space-derivative bump mapping (Mikkelsen); h in arbitrary units, scale -> world units
vec3 bumpNormal(vec3 wp, vec3 N, float h, float scale) {
  vec3 dpdx = dFdx(wp), dpdy = dFdy(wp);
  float dhx = dFdx(h) * scale, dhy = dFdy(h) * scale;
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - grad);
}

void main() {
#ifdef SHADOW_PASS
  #if defined(ALPHA_MASK)
    float sa = uBaseColor.a;
    #ifdef TEX_BASE
      sa *= texture(uTexBase, vUV).a;
    #endif
    if (sa < uAlphaCutoff * 0.85) discard;
  #endif
  outColor = vec4(0.0);
#else
  vec4 base = uBaseColor * vColor;
#ifdef TEX_BASE
  base *= texture(uTexBase, vUV);
#endif

#ifdef PAINT
  if (uPaint.w > 0.5) {
    vec3 hsv = rgb2hsv(base.rgb);
    // only recolor saturated (painted) pixels; leave neutrals (black trim, silver) untouched
    float m = smoothstep(0.18, 0.45, hsv.y);
    vec3 shifted = hsv2rgb(vec3(fract(hsv.x + uPaint.x), clamp(hsv.y * uPaint.y, 0.0, 1.0), clamp(hsv.z * uPaint.z, 0.0, 1.0)));
    // for desaturated (white/grey/black) paint targets, allow a direct value/sat override
    base.rgb = mix(base.rgb, shifted, m);
  }
#endif

#ifdef ALPHA_MASK
  #ifdef TEX_BASE
    vec2 ts = vec2(textureSize(uTexBase, 0));
    vec2 dx = dFdx(vUV * ts), dy = dFdy(vUV * ts);
    float lod = max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-6)));
    base.a *= 1.0 + uMipBoost * lod;
  #endif
  #ifdef A2C
    float aw = max(fwidth(base.a), 1e-4);
    base.a = clamp((base.a - uAlphaCutoff) / aw + 0.5, 0.0, 1.0);
    if (base.a <= 0.0) discard;
  #else
    if (base.a < uAlphaCutoff) discard;
    base.a = 1.0;
  #endif
#endif

  vec3 N = normalize(vN);
#ifdef DOUBLE_SIDED
  if (!gl_FrontFacing) N = -N;
#endif
  vec3 wp = vWorld;
  vec3 toCam = uCamPos - wp;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);

  float metal = uMR.x;
  float rough = uMR.y;
  float ao = vAO;
  vec3 emissive = uEmissive;

#ifdef TERRAIN
  float tRough, tHeight;
  vec3 tAlb = terrainSurface(wp, N, vColor, tRough, tHeight);
  base.rgb = tAlb;
  rough = tRough;
#ifndef LITE
  N = bumpNormal(wp, N, tHeight, 0.07 * clamp(1.0 - dist * 0.025, 0.0, 1.0));
#endif
#endif

#ifdef ROAD
  float rRough, rHeight, rMark;
  vec3 rAlb = roadSurface(vUV, wp, rRough, rHeight, rMark);
  base.rgb = rAlb;
  rough = rRough;
  // wet look: darker, glossier in patchy puddles
  float puddle = 0.0, wet = 0.0;
  if (uWet > 0.01) {
    puddle = smoothstep(0.35, 0.7, vnoise(wp.xz * 0.045) * 0.65 + vnoise(wp.xz * 0.21) * 0.35);
    wet = uWet * mix(0.5, 1.0, puddle) * (1.0 - rMark * 0.7);
    base.rgb *= mix(1.0, 0.55, wet);
    rough = mix(rough, 0.07 + 0.1 * (1.0 - puddle), wet);
  }
#ifndef LITE
  N = bumpNormal(wp, N, rHeight, 0.012 * (1.0 - wet * 0.8) * clamp(1.0 - dist * 0.04, 0.0, 1.0));
#endif
#endif

#ifdef TEX_NORMAL
  {
    vec3 dp1 = dFdx(wp), dp2 = dFdy(wp);
    vec2 duv1 = dFdx(vUV), duv2 = dFdy(vUV);
    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
    vec3 tn = texture(uTexNormal, vUV).xyz * 2.0 - 1.0;
    tn.xy *= uNormalScale;
    N = normalize(T * invmax * tn.x + B * invmax * tn.y + N * tn.z);
  }
#endif
#ifdef TEX_MR
  {
    vec4 mr = texture(uTexMR, vUV);
    rough *= mr.g;
    metal *= mr.b;
  }
#endif
#ifdef TEX_OCC
  ao *= 1.0 + uOccStrength * (texture(uTexOcc, vUV).r - 1.0);
#endif
#ifdef TEX_EMIS
  emissive *= texture(uTexEmis, vUV).rgb;
#endif
#ifdef LIGHTS_EMISSIVE
  emissive += base.rgb * uEmissiveBoost;
#endif
#ifdef GRAIN
  {
    float gn = vnoise(wp.xz * 9.0 + wp.y * 5.0) * 0.6 + vnoise(wp.xz * 41.0 + wp.y * 23.0) * 0.4;
    base.rgb *= 0.82 + 0.36 * gn;
  }
#endif

  rough = clamp(rough, 0.04, 1.0);
  vec3 albedo = base.rgb;
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 diffC = albedo * (1.0 - metal);
  float NoV = max(dot(N, V), 1e-4);
  float a = rough * rough;

  // ---- sun ----
  vec3 L = uSunDir;
  float NoL = dot(N, L);
  float sh = 1.0;
  vec3 col = vec3(0.0);
  float sunVis = 1.0;
#ifdef FOLIAGE
  {
    float wrapNoL = clamp((NoL + 0.45) / 1.45, 0.0, 1.0);
    sh = shadowFactor(wp, normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.5)) * 0.5);
    float back = pow(clamp(dot(-V, L), 0.0, 1.0), 2.5);
    vec3 trans = albedo * vec3(1.1, 1.0, 0.55) * back * 0.9 * sh;
    col += (diffC / PI * wrapNoL * sh + trans / PI) * uSunColor * ao;
    sunVis = sh;
  }
#else
  if (NoL > 0.0) {
    sh = shadowFactor(wp, N);
    vec3 H = normalize(V + L);
    float NoH = clamp(dot(N, H), 0.0, 1.0);
    float VoH = clamp(dot(V, H), 0.0, 1.0);
    vec3 spec = D_GGX(NoH, a) * V_SmithGGX(NoV, NoL, a) * F_Schlick(F0, VoH);
    col += (diffC / PI + spec) * uSunColor * NoL * sh;
    sunVis = sh;
  }
#endif

  // ---- dynamic spot lights (headlights) ----
  for (int i = 0; i < 4; i++) {
    if (i >= uNumSpots) break;
    vec3 toL = uSpotPos[i].xyz - wp;
    float d = length(toL);
    vec3 l = toL / max(d, 1e-3);
    float cd = dot(-l, uSpotDir[i].xyz);
    float spot = smoothstep(uSpotDir[i].w, uSpotColor[i].w, cd);
    float rng = uSpotPos[i].w;
    float att = spot / (1.0 + d * d * 0.012) * smoothstep(rng, rng * 0.5, d);
    float nl = max(dot(N, l), 0.0);
    if (att > 0.0 && nl > 0.0) {
      vec3 H = normalize(V + l);
      float NoH = clamp(dot(N, H), 0.0, 1.0);
      float VoH = clamp(dot(V, H), 0.0, 1.0);
      vec3 spec = D_GGX(NoH, a) * V_SmithGGX(NoV, nl, a) * F_Schlick(F0, VoH);
      col += (diffC / PI + spec) * uSpotColor[i].rgb * att * nl;
    }
  }

  // ---- image based ambient ----
  {
    vec3 Nb = N;
    #ifdef FOLIAGE
    Nb = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.35));
    #endif
    vec3 irr = textureLod(uEnvSpec, Nb, uAmbLod).rgb * uEnvIntensity * uAmbientTint;
    col += diffC * irr * ao;
#if defined(LITE) && (defined(TERRAIN) || defined(INSTANCED))
    if (false) {   // ground + trees: sky reflection is invisible on them, skip the second cubemap read
#endif
    vec3 R = reflect(-V, N);
    float lod = clamp(rough * (uEnvMaxLod - 0.5), 0.0, uEnvMaxLod);
    vec3 pre = textureLod(uEnvSpec, R, lod).rgb * uEnvIntensity;
    vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 rr = rough * c0 + c1;
    float a004 = min(rr.x * rr.x, exp2(-9.28 * NoV)) * rr.x + rr.y;
    vec2 AB = vec2(-1.04, 1.04) * a004 + rr.zw;
    float specAO = clamp(pow(NoV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
    // reflections of the sky are suppressed in deep shadow / below horizon for non-metals
    float horizon = clamp(1.0 + R.y * 1.5, 0.0, 1.0);
    col += pre * (F0 * AB.x + AB.y) * specAO * mix(horizon, 1.0, metal);
#if defined(LITE) && (defined(TERRAIN) || defined(INSTANCED))
    }
#endif
  }

  col += emissive;

  // ---- fog ----
  {
    vec3 vd = -V;
    float hfall = exp(-max(wp.y - uFogHeight.x, 0.0) * uFogHeight.y);
    float f = 1.0 - exp(-dist * uFogDensity * hfall);
    vec3 fc = mix(uFogColor, uFogSunColor, pow(max(dot(vd, uSunDir), 0.0), 6.0));
    col = mix(col, fc, clamp(f, 0.0, 1.0));
  }

  #ifdef ALPHA_BLEND
    float alpha = base.a;
    // fresnel makes glass more reflective at grazing angles
    float fres = pow(1.0 - NoV, 4.0);
    alpha = clamp(alpha + fres * 0.6, 0.0, 1.0);
    outColor = vec4(OUTC(col), alpha);
  #else
    #ifdef A2C
      outColor = vec4(OUTC(col), base.a);
    #else
      outColor = vec4(OUTC(col), 1.0);
    #endif
  #endif
#endif
}
`;

// ---------------- sky ----------------
export const SKY_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vPos;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vPos = p * 2.0 - 1.0;
  gl_Position = vec4(vPos, 0.9999999, 1.0);
}
`;

export const SKY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vPos;
out vec4 outColor;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunGlow;
uniform vec3 uSunDisc;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
uniform float uCloudCover;
uniform float uStars;
uniform float uOutScale;
${OUT_GLSL}
uniform float uHorizonPow;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * .1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

vec3 skyColor(vec3 d) {
  float h = d.y;
  float g = pow(1.0 - clamp(h, 0.0, 1.0), uHorizonPow);
  vec3 col = mix(uZenith, uHorizon, g);
  if (h < 0.0) col = mix(uHorizon, uGround, (1.0 - smoothstep(-0.18, 0.0, h)));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunGlow * (pow(sd, 6.0) * 0.30 + pow(sd, 40.0) * 0.55 + pow(sd, 400.0) * 1.2);
  // sun disc
  float disc = smoothstep(0.99988, 0.99996, sd);
  col += uSunDisc * disc;
  // stars
  if (uStars > 0.0 && h > 0.0) {
    vec3 sp = d * 220.0;
    vec3 ip = floor(sp);
    float r = hash13(ip);
    float star = step(0.9965, r) * (1.0 - smoothstep(0.0, 0.5, length(fract(sp) - 0.5))) ;
    float tw = 0.7 + 0.3 * sin(uTime * 2.0 + r * 40.0);
    col += vec3(0.9, 0.95, 1.0) * star * tw * uStars * smoothstep(0.0, 0.2, h) * 3.0;
  }
  // clouds
  if (h > 0.015 && uCloudCover > 0.01) {
    vec2 p = d.xz / (h * 0.55 + 0.22);
    p = p * 0.9 + vec2(uTime * 0.006, uTime * 0.0025);
    float n = fbm(p * 1.15);
    float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.28, n);
    float n2 = fbm(p * 1.15 + uSunDir.xz * 0.12);
    float shade = clamp((n - n2) * 4.0 + 0.55, 0.0, 1.0);
    vec3 cc = mix(uCloudDark, uCloudLit, shade);
    cc += uSunGlow * pow(sd, 10.0) * 0.5 * (1.0 - cov * 0.4);
    float fade = smoothstep(0.015, 0.22, h);
    col = mix(col, cc, cov * fade * 0.92);
  }
  return col;
}

void main() {
  vec4 wp = uInvViewProj * vec4(vPos, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w - uCamPos);
#ifdef LITE
  outColor = vec4(OUTC(skyColor(dir)) + (hash12(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
#else
  outColor = vec4(skyColor(dir) * uOutScale, 1.0);
#endif
}
`;

// ---------------- particles (instanced billboards) ----------------
export const PARTICLE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec4 aPosSize;   // xyz, size
layout(location=1) in vec4 aColor;     // rgba (premult handled in fs)
layout(location=2) in vec4 aVelKind;   // xyz velocity, kind (0 soft, 1 spark, 2 smoke, 3 glow)
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
out vec2 vUV;
out vec4 vColor;
flat out float vKind;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vUV = c;
  vColor = aColor;
  vKind = aVelKind.w;
  vec3 pos = aPosSize.xyz;
  float size = aPosSize.w;
  vec3 right = uCamRight, up = uCamUp;
  if (aVelKind.w > 0.5 && aVelKind.w < 1.5) {
    // streak: stretch along velocity
    vec3 v = aVelKind.xyz;
    float sp = length(v);
    vec3 vd = v / max(sp, 1e-3);
    vec3 toCam = normalize(uCamPos - pos);
    vec3 side = normalize(cross(vd, toCam));
    right = side;
    up = vd;
    pos += vd * 0.0;
    vec3 wpos = pos + right * c.x * size * 0.35 + up * c.y * size * (0.6 + min(sp, 40.0) * 0.05);
    gl_Position = uViewProj * vec4(wpos, 1.0);
    return;
  }
  vec3 wpos = pos + (right * c.x + up * c.y) * size;
  gl_Position = uViewProj * vec4(wpos, 1.0);
}
`;

export const PARTICLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
flat in float vKind;
out vec4 outColor;
uniform float uOutScale;
${OUT_GLSL}
uniform float uTime;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float r2 = dot(vUV, vUV);
  float a;
  float edge = 1.0 - smoothstep(0.45, 1.0, r2);   // always reaches zero before the quad border
  if (vKind < 0.5) {            // soft round
    a = exp(-r2 * 3.2) * edge;
  } else if (vKind < 1.5) {     // spark streak
    float x = abs(vUV.x), y = abs(vUV.y);
    a = (1.0 - smoothstep(0.0, 1.0, x)) * (1.0 - smoothstep(0.1, 1.0, y));
    a = pow(a, 1.5);
  } else if (vKind < 2.5) {     // smoke puff
    float n = vnoise(vUV * 2.2 + vColor.rg * 40.0) * 0.6 + vnoise(vUV * 5.0 + vColor.b * 30.0) * 0.4;
    float x = r2 * (1.15 - 0.45 * n);
    a = (1.0 - smoothstep(0.1, 0.95, x)) * edge;
    a *= 0.75 + 0.5 * n;
  } else {                      // glow
    a = exp(-r2 * 3.4) * edge;
  }
  outColor = vec4(OUTC(vColor.rgb), vColor.a * a);
}
`;

// ---------------- post processing ----------------
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const BLOOM_DOWN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;     // 1/src size
uniform float uThreshold;
uniform float uKnee;
uniform int uFirst;
uniform float uInScale;
vec3 prefilter(vec3 c) {
  float br = max(max(c.r, c.g), c.b);
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * contrib;
}
vec3 fetch(vec2 uv) {
  vec3 c = texture(uSrc, uv).rgb * uInScale;
  return uFirst == 1 ? min(c, vec3(60.0)) : c;
}
void main() {
  vec2 uv = vUV;
  vec2 t = uTexel;
  vec3 a = fetch(uv + t * vec2(-2, -2)), b = fetch(uv + t * vec2(0, -2)), c = fetch(uv + t * vec2(2, -2));
  vec3 d = fetch(uv + t * vec2(-2, 0)), e = fetch(uv), f = fetch(uv + t * vec2(2, 0));
  vec3 g = fetch(uv + t * vec2(-2, 2)), h = fetch(uv + t * vec2(0, 2)), i = fetch(uv + t * vec2(2, 2));
  vec3 j = fetch(uv + t * vec2(-1, -1)), k = fetch(uv + t * vec2(1, -1));
  vec3 l = fetch(uv + t * vec2(-1, 1)), m = fetch(uv + t * vec2(1, 1));
  vec3 res;
  if (uFirst == 1) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = 1.0 / (1.0 + dot(g0, vec3(0.2126, 0.7152, 0.0722)));
    float w1 = 1.0 / (1.0 + dot(g1, vec3(0.2126, 0.7152, 0.0722)));
    float w2 = 1.0 / (1.0 + dot(g2, vec3(0.2126, 0.7152, 0.0722)));
    float w3 = 1.0 / (1.0 + dot(g3, vec3(0.2126, 0.7152, 0.0722)));
    float w4 = 1.0 / (1.0 + dot(g4, vec3(0.2126, 0.7152, 0.0722)));
    // 0.125 weights as in COD: but use karis-weighted groups
    res = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) / (0.125 * (w0 + w1 + w2 + w3) + 0.5 * w4);
    res = prefilter(res);
  } else {
    res = e * 0.125;
    res += (a + c + g + i) * 0.03125;
    res += (b + d + f + h) * 0.0625;
    res += (j + k + l + m) * 0.125;
  }
  outColor = vec4(res, 1.0);
}
`;

export const BLOOM_UP_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uWeight;
void main() {
  vec2 t = uTexel;
  vec3 c = texture(uSrc, vUV).rgb * 4.0;
  c += texture(uSrc, vUV + t * vec2(-1, 0)).rgb * 2.0;
  c += texture(uSrc, vUV + t * vec2(1, 0)).rgb * 2.0;
  c += texture(uSrc, vUV + t * vec2(0, -1)).rgb * 2.0;
  c += texture(uSrc, vUV + t * vec2(0, 1)).rgb * 2.0;
  c += texture(uSrc, vUV + t * vec2(-1, -1)).rgb;
  c += texture(uSrc, vUV + t * vec2(1, -1)).rgb;
  c += texture(uSrc, vUV + t * vec2(-1, 1)).rgb;
  c += texture(uSrc, vUV + t * vec2(1, 1)).rgb;
  outColor = vec4(c / 16.0 * uWeight, 1.0);
}
`;

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uInScale;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uBlur;          // radial motion blur strength
uniform vec2 uBlurCenter;
uniform float uCA;            // chromatic aberration
uniform float uVignette;
uniform float uSpeedLines;
uniform float uFlash;         // white/orange flash (nitro burst, impact)
uniform vec3 uFlashColor;
uniform float uTime;
uniform float uSaturation;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uContrast;
uniform vec2 uSunUV;
uniform float uSunShaft;      // god-ray intensity
uniform float uAspect;
uniform float uGrain;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 acesFilm(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 sampleScene(vec2 uv) {
  return texture(uScene, uv).rgb * uInScale;
}
void main() {
  vec2 uv = vUV;
  vec2 dir = uv - uBlurCenter;
  float r = length(dir * vec2(uAspect, 1.0));
  vec3 col;
  // chromatic aberration + radial blur
  float blurAmt = uBlur * smoothstep(0.05, 0.9, r);
  vec3 acc = vec3(0.0);
  const int N = 10;
  float wsum = 0.0;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1);
    float w = 1.0 - t * 0.5;
    vec2 off = dir * (-blurAmt * t);
    vec2 ca = dir * uCA * r * (0.3 + t);
    vec3 s;
    s.r = sampleScene(uv + off + ca).r;
    s.g = sampleScene(uv + off).g;
    s.b = sampleScene(uv + off - ca).b;
    acc += s * w;
    wsum += w;
  }
  col = acc / wsum;
  vec3 bloom = texture(uBloom, uv).rgb * uInScale;
  col += bloom * uBloomStrength;

  // sun shafts: radial march toward the sun using the bloom buffer (bright pixels only)
  if (uSunShaft > 0.001) {
    vec2 sd = (uSunUV - uv);
    float sl = length(sd * vec2(uAspect, 1.0));
    vec3 shaft = vec3(0.0);
    const int NS = 24;
    for (int i = 0; i < NS; i++) {
      float t = (float(i) + hash12(gl_FragCoord.xy + float(i))) / float(NS);
      shaft += texture(uBloom, uv + sd * t * 0.9).rgb;
    }
    shaft = shaft / float(NS) * uInScale;
    col += shaft * uSunShaft * (1.0 - smoothstep(0.0, 1.4, sl));
  }

  // speed lines
  if (uSpeedLines > 0.001) {
    float ang = atan(dir.y, dir.x * uAspect);
    float n = hash12(vec2(floor(ang * 70.0), floor(uTime * 24.0)));
    float n2 = hash12(vec2(floor(ang * 23.0 + 5.0), floor(uTime * 9.0)));
    float line = smoothstep(0.82, 1.0, n * 0.6 + n2 * 0.5) * smoothstep(0.28, 0.8, r);
    col += vec3(0.8, 0.9, 1.0) * line * uSpeedLines * 0.5;
  }

  col += uFlashColor * uFlash * (0.4 + r * 1.2);
  col *= uExposure;
  // vignette
  col *= 1.0 - uVignette * smoothstep(0.35, 1.25, r);
  vec3 mapped = acesFilm(col);
  // grading
  float l = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
  mapped = mix(vec3(l), mapped, uSaturation);
  mapped = mapped * uGain + uLift * (1.0 - mapped);
  mapped = (mapped - 0.5) * uContrast + 0.5;
  mapped = clamp(mapped, 0.0, 1.0);
  mapped = pow(mapped, vec3(1.0 / 2.2));
  // dither / grain
  float g = hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5;
  mapped += g * (1.0 / 255.0 + uGrain);
  outColor = vec4(mapped, 1.0);
}
`;

// ---------------- flat additive decals (light pools) ----------------
export const DECAL_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec4 aPosSize;
layout(location=1) in vec4 aColor;
uniform mat4 uViewProj;
out vec2 vUV;
out vec4 vColor;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vUV = c;
  vColor = aColor;
  vec3 p = aPosSize.xyz + vec3(c.x, 0.0, c.y) * aPosSize.w;
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;
export const DECAL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
out vec4 outColor;
uniform float uOutScale;
${OUT_GLSL}
void main() {
  float r2 = dot(vUV, vUV);
  float a = pow(max(1.0 - r2, 0.0), 2.2);
  outColor = vec4(OUTC(vColor.rgb), a * vColor.a);
}
`;
