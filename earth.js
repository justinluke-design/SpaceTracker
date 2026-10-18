// earth.js: stylised Earth. The look is controlled by CSS variables in style.css.
import * as THREE from 'three';
import { feature, mesh as topoMesh } from 'topojson-client';

const TOPO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';

// ---------- read the theme from style.css ----------
const css = getComputedStyle(document.documentElement);          // live: always reflects the current CSS
const str = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const num = (name, fallback) => {
  const v = parseFloat(css.getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
};

function readTheme() {
  return {
    style:            str('--earth-style', 'map'),                // map | dots
    resolution:       num('--map-resolution', 4096),
    ocean:            str('--earth-ocean', '#030a18'),
    land:             str('--earth-land', 'rgba(0, 150, 210, 0.30)'),
    border:           str('--earth-border', '#3ae8ff'),
    borderWidth:      num('--earth-border-width', 2),
    borderGlow:       str('--earth-border-glow', '#00d0ff'),
    borderGlowSize:   num('--earth-border-glow-size', 8),
    grid:             str('--earth-grid', 'rgba(0, 200, 255, 0.14)'),
    gridStep:         num('--earth-grid-step', 15),
    dotColor:         str('--earth-dot-color', '#3ae8ff'),
    dotSpacing:       num('--earth-dot-spacing', 1.1),
    dotSize:          num('--earth-dot-size', 0.012),
    atmoOuter:        str('--atmo-outer', '#4f91ff'),
    atmoEdge:         str('--atmo-edge', '#94cfff'),
    atmoGlow:         num('--atmo-glow', 1.1),
    atmoHaze:         str('--atmo-haze', '#8ac4ff'),
    atmoHazeStrength: num('--atmo-haze-strength', 0.6),
    hazeReach:        num('--atmo-haze-reach', 4),
    hazeFace:         num('--atmo-haze-face', 0.12),
    atmoSize:         num('--atmo-size', 1.04),
    atmoSun:          num('--atmo-sun', 1),
    outerHaze:        str('--outer-haze', '#4a7dff'),
    outerHazeStrength:num('--outer-haze-strength', 0.55),
    outerHazeSize:    num('--outer-haze-size', 1.3),
    turbulence:       num('--atmo-turbulence', 0.6),
    turbulenceScale:  num('--atmo-turbulence-scale', 3),
    turbulenceSpeed:  num('--atmo-turbulence-speed', 0.05),
  };
}

// theme values that need the map / dots to be redrawn (the atmosphere updates instantly instead)
const LAYER_KEYS = ['style', 'resolution', 'ocean', 'land', 'border', 'borderWidth', 'borderGlow',
                    'borderGlowSize', 'grid', 'gridStep', 'dotColor', 'dotSpacing', 'dotSize'];

// ---------- helpers ----------
function latLonToVec3(lat, lon, r) {
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

// direction from Earth to the Sun at a given time (same axes as your toScene())
const _sun = new THREE.Vector3();
function sunDirection(date) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const rad = Math.PI / 180;
  const L = (280.460 + 0.9856474 * d) * rad;
  const g = (357.528 + 0.9856003 * d) * rad;
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * d) * rad;
  return _sun.set(Math.cos(lambda), Math.sin(eps) * Math.sin(lambda), -Math.cos(eps) * Math.sin(lambda));
}

// Paint the world onto a flat 2:1 canvas. Wrapped onto the sphere it lines up exactly like a photo texture.
function paintMap(topo, W, t, { mask = false } = {}) {
  const H = W / 2;
  const k = W / 4096;                                            // keeps line widths the same at any resolution
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const X = lon => (lon + 180) / 360 * W;
  const Y = lat => (90 - lat) / 180 * H;

  g.fillStyle = mask ? '#000' : t.ocean;
  g.fillRect(0, 0, W, H);

  if (!mask && t.gridStep > 0) {
    g.strokeStyle = t.grid;
    g.lineWidth = Math.max(1, k);
    g.beginPath();
    for (let lon = -180; lon <= 180; lon += t.gridStep) { g.moveTo(X(lon), 0); g.lineTo(X(lon), H); }
    for (let lat = -90; lat <= 90; lat += t.gridStep)   { g.moveTo(0, Y(lat)); g.lineTo(W, Y(lat)); }
    g.stroke();
  }

  g.fillStyle = mask ? '#fff' : t.land;
  for (const f of feature(topo, topo.objects.countries).features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys) {
      g.beginPath();
      for (const ring of rings) {
        ring.forEach(([lon, lat], i) => i ? g.lineTo(X(lon), Y(lat)) : g.moveTo(X(lon), Y(lat)));
        g.closePath();
      }
      g.fill('evenodd');
    }
  }

  if (!mask && t.borderWidth > 0) {
    g.strokeStyle = t.border;
    g.lineWidth = t.borderWidth * k;
    g.shadowColor = t.borderGlow;
    g.shadowBlur = t.borderGlowSize * k;
    g.beginPath();
    for (const line of topoMesh(topo, topo.objects.countries).coordinates) {
      let prev = null;
      for (const [lon, lat] of line) {
        // skip the jump where a border crosses the 180 meridian, so no line is drawn across the whole map
        if (prev !== null && Math.abs(lon - prev) < 180) g.lineTo(X(lon), Y(lat));
        else g.moveTo(X(lon), Y(lat));
        prev = lon;
      }
    }
    g.stroke();
  }
  return c;
}

// 3D noise used to roughen the atmosphere (shared by all three atmosphere layers)
const NOISE = `
  uniform float time;
  uniform float turbulence;
  uniform float turbScale;
  uniform float turbSpeed;
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), f.x),
                   mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
                   mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return s;
  }
  // swirly noise, roughly 0..1, drifting slowly over time. dir = direction from the planet's centre.
  float swirl(vec3 dir) {
    vec3 q = dir * turbScale + time * turbSpeed * vec3(0.7, 0.3, -0.5);
    return fbm(q + 1.6 * fbm(q * 1.7 + 4.0));
  }
`;

// shared vertex shader for the atmosphere layers
const VERT = `
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormalW  = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

export function createEarth(scene, radius, opts = {}) {
  const { topoUrl = TOPO_URL } = opts;

  const sunDirUniform = { value: new THREE.Vector3(1, 0, 0) };
  const timeU = { value: 0 }, turbU = { value: 0.6 }, turbScaleU = { value: 3 }, turbSpeedU = { value: 0.05 };
  const group = new THREE.Group();            // everything that turns with the planet
  scene.add(group);

  // base globe: your raycaster uses this, and it hides the far side
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 96, 96),
    new THREE.MeshBasicMaterial({ color: 0x030a18 })
  );
  group.add(earth);

  // ---------- atmosphere ----------
  const glow = new THREE.Mesh(                // close-in glow: brightest right at the Earth's edge, fading outward
    new THREE.SphereGeometry(radius, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: {
        time: timeU, turbulence: turbU, turbScale: turbScaleU, turbSpeed: turbSpeedU,
        sunDir: sunDirUniform,
        maxFacing: { value: 0.3 },
        colOuter: { value: new THREE.Color() },
        colEdge: { value: new THREE.Color() },
        strength: { value: 1 },
        sunInfluence: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: NOISE + `
        uniform vec3 sunDir; uniform float maxFacing; uniform vec3 colOuter; uniform vec3 colEdge;
        uniform float strength; uniform float sunInfluence;
        varying vec3 vNormalW; varying vec3 vViewDirW;
        void main() {
          vec3 n = normalize(vNormalW);
          float k = clamp(-dot(n, normalize(vViewDirW)) / maxFacing, 0.0, 1.0);
          float blotch = 1.0;
          if (turbulence > 0.0) {
            float s = swirl(n);
            k = clamp(k + (s - 0.5) * turbulence * 1.4, 0.0, 1.0);             // wobbles the edge
            blotch = mix(1.0, 0.35 + 1.3 * s, turbulence);                      // uneven brightness
          }
          float day = mix(1.0, clamp(dot(n, sunDir) * 0.7 + 0.45, 0.0, 1.0), sunInfluence);
          vec3 col = mix(colOuter, colEdge, k);
          gl_FragColor = vec4(col * pow(k, 3.0) * blotch * day * strength, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    })
  );
  scene.add(glow);

   const haze = new THREE.Mesh(                // inner haze: edge rim plus mist over the face
    new THREE.SphereGeometry(radius * 1.012, 96, 96),
    new THREE.ShaderMaterial({
      uniforms: {
        time: timeU, turbulence: turbU, turbScale: turbScaleU, turbSpeed: turbSpeedU,
        sunDir: sunDirUniform,
        color: { value: new THREE.Color() },
        strength: { value: 0.6 },
        reach: { value: 4 },
        face: { value: 0.12 },
        sunInfluence: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: NOISE + `
        uniform vec3 sunDir; uniform vec3 color; uniform float strength; uniform float sunInfluence;
        uniform float reach; uniform float face;
        varying vec3 vNormalW; varying vec3 vViewDirW;
        void main() {
          vec3 n = normalize(vNormalW);
          float f = 1.0 - max(dot(n, normalize(vViewDirW)), 0.0);
          float s = 0.5;
          if (turbulence > 0.0 || face > 0.0) s = swirl(n * 1.3 + 7.0);
          float blotch = 1.0;
          if (turbulence > 0.0) {
            f = clamp(f + (s - 0.5) * turbulence * 1.1, 0.0, 1.0);
            blotch = mix(1.0, 0.3 + 1.4 * s, turbulence);
          }
          float rim = pow(f, reach) * blotch;                                   // the edge haze
          float mist = face * smoothstep(0.35, 0.8, s) * (0.5 + 0.5 * f);       // patches of mist over the whole face
          float day = mix(1.0, clamp(dot(n, sunDir) * 0.8 + 0.4, 0.0, 1.0), sunInfluence);
          gl_FragColor = vec4(color * (rim * strength + mist) * day, 1.0);
          #include <colorspace_fragment>
        }`,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    })
  );
  scene.add(haze);

  const outer = new THREE.Mesh(               // outer haze: a big, soft, turbulent cloud around the planet
    new THREE.SphereGeometry(radius, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: {
        time: timeU, turbulence: turbU, turbScale: turbScaleU, turbSpeed: turbSpeedU,
        sunDir: sunDirUniform,
        maxFacing: { value: 0.6 },
        color: { value: new THREE.Color() },
        strength: { value: 0.5 },
        sunInfluence: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: NOISE + `
        uniform vec3 sunDir; uniform float maxFacing; uniform vec3 color;
        uniform float strength; uniform float sunInfluence;
        varying vec3 vNormalW; varying vec3 vViewDirW;
        void main() {
          vec3 n = normalize(vNormalW);
          float k = clamp(-dot(n, normalize(vViewDirW)) / maxFacing, 0.0, 1.0);
          float wisp = 1.0;
          if (turbulence > 0.0) {
            float s = swirl(n * 0.8 + 3.0);
            k = clamp(k + (s - 0.5) * turbulence * 1.4, 0.0, 1.0);            // pushes the edge in and out
            wisp = mix(1.0, smoothstep(0.25, 0.75, s) * 1.6, turbulence);     // patchy, uneven brightness
          }
          float day = mix(1.0, clamp(dot(n, sunDir) * 0.7 + 0.45, 0.0, 1.0), sunInfluence);
          gl_FragColor = vec4(color * pow(k, 2.4) * wisp * day * strength, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    })
  );
  scene.add(outer);

  // ---------- map / dots layer (rebuilt when its CSS values change) ----------
  let topo = null;
  let dotsObj = null;
  let lastLayerKey = '';

  const dotTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
    return new THREE.CanvasTexture(c);
  })();

  function clearLayer() {
    if (earth.material.map) { earth.material.map.dispose(); earth.material.map = null; }
    if (dotsObj) {
      group.remove(dotsObj);
      dotsObj.geometry.dispose(); dotsObj.material.dispose();
      dotsObj = null;
    }
  }

  function buildMap(t) {
    const W = Math.min(8192, Math.max(512, t.resolution));
    const tex = new THREE.CanvasTexture(paintMap(topo, W, t));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    earth.material.map = tex;
    earth.material.color.set(0xffffff);
    earth.material.needsUpdate = true;
  }

  function buildDots(t) {
    earth.material.color.setStyle(t.ocean);
    earth.material.needsUpdate = true;
    const W = 1024, H = 512;
    const px = paintMap(topo, W, t, { mask: true }).getContext('2d').getImageData(0, 0, W, H).data;
    const isLand = (lat, lon) => {
      const x = Math.min(W - 1, Math.floor((lon + 180) / 360 * W));
      const y = Math.min(H - 1, Math.floor((90 - lat) / 180 * H));
      return px[(y * W + x) * 4] > 128;
    };
    const step = Math.max(0.4, t.dotSpacing);
    const pts = [];
    for (let lat = -88; lat <= 88; lat += step) {
      const lonStep = step / Math.max(Math.cos(lat * Math.PI / 180), 0.05);
      for (let lon = -180; lon < 180; lon += lonStep) {
        if (isLand(lat, lon)) pts.push(latLonToVec3(lat, lon, radius * 1.002));
      }
    }
    dotsObj = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.PointsMaterial({
        color: new THREE.Color().setStyle(t.dotColor), size: radius * t.dotSize,
        sizeAttenuation: true, map: dotTex, alphaTest: 0.5, transparent: true,
      })
    );
    group.add(dotsObj);
  }

  function apply(t) {
    // atmosphere: cheap, updates every time
    const gu = glow.material.uniforms;
    gu.colOuter.value.setStyle(t.atmoOuter);
    gu.colEdge.value.setStyle(t.atmoEdge);
    gu.strength.value = t.atmoGlow;
    gu.sunInfluence.value = t.atmoSun;
    glow.scale.setScalar(t.atmoSize);
    gu.maxFacing.value = Math.sqrt(1 - 1 / (t.atmoSize * t.atmoSize));
    const hu = haze.material.uniforms;
    hu.color.value.setStyle(t.atmoHaze);
    hu.strength.value = t.atmoHazeStrength;
    hu.reach.value = t.hazeReach;
    hu.face.value = t.hazeFace;
    hu.sunInfluence.value = t.atmoSun;

    const ou = outer.material.uniforms;
    ou.color.value.setStyle(t.outerHaze);
    ou.strength.value = t.outerHazeStrength;
    ou.sunInfluence.value = t.atmoSun;
    outer.scale.setScalar(t.outerHazeSize);
    ou.maxFacing.value = Math.sqrt(1 - 1 / (t.outerHazeSize * t.outerHazeSize));
    turbU.value = t.turbulence;
    turbScaleU.value = t.turbulenceScale;
    turbSpeedU.value = t.turbulenceSpeed;

    // map / dots: only redrawn when one of its values changed
    const key = JSON.stringify(LAYER_KEYS.map(k => t[k]));
    if (topo && key !== lastLayerKey) {
      lastLayerKey = key;
      clearLayer();
      if (t.style === 'dots') buildDots(t); else buildMap(t);
    }
  }

  // apply now, then re-check the CSS a couple of times a second so edits show up live
  let lastTheme = '';
  function checkTheme() {
    const t = readTheme();
    const s = JSON.stringify(t);
    if (s !== lastTheme) { lastTheme = s; apply(t); }
  }
  checkTheme();
  setInterval(checkTheme, 400);

  fetch(topoUrl).then(r => r.json()).then(data => { topo = data; lastTheme = ''; checkTheme(); })
    .catch(err => console.warn('Could not load map data:', err));

  return {
    earth,
    update(now, gmst) {
      group.rotation.y = gmst;
      sunDirUniform.value.copy(sunDirection(now));
      timeU.value = performance.now() / 1000;                        // real seconds, so the haze drifts at a steady pace
    },
  };
}