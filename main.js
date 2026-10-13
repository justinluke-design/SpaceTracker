import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as satellite from 'satellite.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// Scale and size constants
const SCALE = 1000;                 // 1 scene unit = 1000 km
const EARTH_RADIUS = 6371 / SCALE;  // Earth is about 6.37 units wide
const TIME_SPEED = 1;                // 1 = real time. Try 60 to see motion faster.

// Categories
const PER_CATEGORY = 25;

const CATEGORIES = {
  'Weather & Earth':  { color: 0x4ade80, groups: ['weather', 'resource'] },
  'Communications':   { color: 0xfb923c, groups: ['oneweb', 'kuiper', 'geo'] },
  'Navigation':       { color: 0xa78bfa, groups: ['gnss'] },
  'Scientific':       { color: 0x22d3ee, groups: ['science'] },
  'Military & Radar': { color: 0xf87171, groups: ['military', 'radar'] },
  'Stations': {
  color: 0xE8E1DF,
  groups: ['stations'],
  only: [25544, 48274],
  size: 0.2,
  names: { 25544: 'International Space Station', 48274: 'Tiangong' },
},
};

const hex = (c) => '#' + c.toString(16).padStart(6, '0');   // Turns to string so it can read colour

// Determines newest/ most recent satellites
function newest(records, n) {
  return [...records]
    .sort((a, b) => Number(b.NORAD_CAT_ID) - Number(a.NORAD_CAT_ID))
    .slice(0, n);
}


// Scene
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 10, 25);

// Background
//const starTexture = new THREE.TextureLoader().load('./stars.jpg');
//starTexture.mapping = THREE.EquirectangularReflectionMapping;   // wraps the image around the scene
//starTexture.colorSpace = THREE.SRGBColorSpace;                  // correct colours
//scene.background = starTexture;
//scene.backgroundIntensity = 0.7;                                // lower this if the stars are too bright

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);


// 3D Controls
const controls = new OrbitControls(camera, renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);   // keeps labels aligned
});

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, .8));

const sunLight = new THREE.DirectionalLight(0xffffff, 2);
sunLight.position.set(50, 20, 30);
scene.add(sunLight);

// Globe
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS, 32, 32),
  new THREE.MeshStandardMaterial({ color: 0x2266cc })
);
scene.add(earth);


// Satellie data fetch
async function getGroup(group) {
  const key = `celestrak-${group}-top`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached && Date.now() - cached.time < 2 * 60 * 60 * 1000) return cached.data;
  } catch {}

  const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=JSON`);
  if (!res.ok) throw new Error(`CelesTrak returned ${res.status} for ${group}. Stop and wait before retrying.`);
  const data = newest(await res.json(), PER_CATEGORY);

  try { localStorage.setItem(key, JSON.stringify({ time: Date.now(), data })); } catch {}
  return data;
}


// Switch Z to Y axis for direction
function toScene(pos) {   // pos is in km
  return new THREE.Vector3(pos.x / SCALE, pos.z / SCALE, -pos.y / SCALE);
}


// Orbit lines
function makeOrbitLine(satrec, periodMinutes, color) {
  const points = [];
  const start = Date.now();
  for (let i = 0; i <= 200; i++) {
    const t = new Date(start + (i / 200) * periodMinutes * 60000);
    const pv = satellite.propagate(satrec, t);
    if (pv && pv.position) points.push(toScene(pv.position));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 })
  );
}


// Actual Satellite meshes & Categories
const sats = [];
const categoryGroups = {};   // category name -> THREE.Group

async function init() {
  for (const [name, cfg] of Object.entries(CATEGORIES)) {
    const group = new THREE.Group();
    scene.add(group);
    categoryGroups[name] = group;

    // collect records from this category's CelesTrak groups, skipping duplicates
     const seen = new Set();
    let records = [];
    for (const g of cfg.groups) {
      for (const rec of await getGroup(g, cfg.only ? 500 : PER_CATEGORY)) {
        if (!seen.has(rec.NORAD_CAT_ID)) {
          seen.add(rec.NORAD_CAT_ID);
          records.push(rec);
        }
      }
    }
records = cfg.only
? records.filter((r) => cfg.only.includes(Number(r.NORAD_CAT_ID)))
: newest(records, PER_CATEGORY);

    for (const rec of records) {
      const satrec = satellite.json2satrec(rec);
      const periodMinutes = 1440 / rec.MEAN_MOTION;

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 16),
        new THREE.MeshBasicMaterial({ color: cfg.color })
      );
      group.add(dot, makeOrbitLine(satrec, periodMinutes, cfg.color));

      const div = document.createElement('div');
      div.className = 'sat-label';
      div.style.color = hex(cfg.color);
      div.textContent = cfg.names?.[rec.NORAD_CAT_ID] ?? rec.OBJECT_NAME;
      const label = new CSS2DObject(div);
      label.position.set(0.25, 0.25, 0);
      dot.add(label);

      sats.push({ name: rec.OBJECT_NAME, satrec, dot, label, category: name });
    }
  }

  buildFilterPanel();
  animate();
}


// Category Names
function setCategoryVisible(name, visible) {
  categoryGroups[name].visible = visible;
  for (const s of sats) {
    if (s.category === name) s.label.visible = visible;   // labels are HTML, so hide them separately
  }
}


// Generative Stars
function makeStarTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.2)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');   // fades to fully transparent at the edge
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function addStars(count, size) {
  const positions = [];
  const colors = [];
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(500);
    positions.push(v.x, v.y, v.z);

    const b = 0.4 + Math.random() * 0.6;                       // random brightness
    colors.push(b, b, b + Math.random() * 0.15);               // slight blue tint on some
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    map: makeStarTexture(),
    size,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,   // overlapping glows add up brightness
  })));
}

addStars(2500, 3);   // lots of small soft stars
addStars(250, 8);    // a few big, blurrier ones


// Labels
function buildFilterPanel() {
  const panel = document.createElement('div');
  panel.style.cssText =
    panel.className = 'filter-panel';
panel.innerHTML = '<div class="filter-title"><b>Categories</b></div>';

  for (const [name, cfg] of Object.entries(CATEGORIES)) {
    const count = sats.filter((s) => s.category === name).length;
    const row = document.createElement('label');
    row.className = 'filter-row';
    row.innerHTML =
      `<input type="checkbox" checked>` +
      `<span style="width:12px;height:12px;border-radius:50%;background:${hex(cfg.color)}"></span>` +
      `${name} (${count})`;
    row.querySelector('input').addEventListener('change', (e) => setCategoryVisible(name, e.target.checked));
    panel.appendChild(row);
  }
  document.body.appendChild(panel);
}

init();

// Hide labels behind the sphere
function isBehindEarth(pos) {
  const toSat = pos.clone().sub(camera.position);
  const dist = toSat.length();
  const dir = toSat.normalize();
  const b = camera.position.dot(dir);
  const c = camera.position.lengthSq() - EARTH_RADIUS * EARTH_RADIUS;
  const disc = b * b - c;
  if (disc < 0) return false;            // line from camera to satellite misses the globe
  const t = -b - Math.sqrt(disc);        // distance to the globe's near surface
  return t > 0 && t < dist;              // globe is in front of the satellite
}


// Animation loop
const FPS = 30;
const frameInterval = 1000 / FPS;   // about 33 ms between frames
let lastRender = 0;

let simTime = Date.now();
let lastFrame = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const t = performance.now();
  if (t - lastRender < frameInterval) return;           // too soon, skip this frame
  lastRender = t - ((t - lastRender) % frameInterval);  // keeps the pacing steady

  // advance simulated time (same as before)
  const realDelta = Math.min(t - lastFrame, 100);
  lastFrame = t;
  simTime += realDelta * timeSpeed;
  const now = new Date(simTime);

  for (const s of sats) {
    if (!categoryGroups[s.category].visible) continue;

    const pv = satellite.propagate(s.satrec, now);
    if (pv && pv.position) s.dot.position.copy(toScene(pv.position));

    // hide the label when the satellite is behind the globe
    s.label.element.style.visibility = isBehindEarth(s.dot.position) ? 'hidden' : 'visible';
  }

  earth.rotation.y = satellite.gstime(now);
  controls.update();
  renderer.render(scene, camera); 
  labelRenderer.render(scene, camera);
}


// UI

// Speed Slider
let timeSpeed = 1;

const panel = document.createElement('div');
panel.className = 'speed-panel'
panel.innerHTML = `
  <div>Time speed: <b id="speedLabel">1.0×</b></div>
  <input id="speedSlider" type="range" min="-1" max="4" step="0.01" value="0" style="width:220px">
`;
document.body.appendChild(panel);

const slider = document.getElementById('speedSlider');
const label = document.getElementById('speedLabel');

slider.addEventListener('input', () => {
  timeSpeed = 10 ** Number(slider.value);   // slider is the exponent: 10^0 = 1x
  label.textContent = timeSpeed >= 10
    ? Math.round(timeSpeed) + '×'
    : timeSpeed.toFixed(1) + '×';
});


// Labels
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';   // IMPORTANT: lets your mouse reach the globe
document.body.appendChild(labelRenderer.domElement);

labelRenderer.setSize(innerWidth, innerHeight);