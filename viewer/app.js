import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createOrbitView, VIEWS } from "./orbit.js";
import { createWalk } from "./walk.js";
import { loadZones } from "./zones.js";
import { createUI } from "./ui.js";

const VIEW_KEYS = Object.keys(VIEWS);
const EYE_HEIGHT = 1.65;
const WALK_FOV = 70;
const ORBIT_FOV = 30;
const ORBIT_SHADOW_RADIUS = 190;
const WALK_SHADOW_RADIUS = 80;
const SUN_OFFSET = new THREE.Vector3(130, 240, 120);
const SUN_TARGET = new THREE.Vector3(30, 0, 0);
const HEMI_WALK = 0.15;
const HEMI_INTERIOR = 0.45;

// site 座標 (x 東, y 北) → glTF (x, -y)；高度是 glTF Y。
const SPAWNS = {
  gate: { site: [92.0, 0.3], ground: 0, yaw: Math.PI / 2 }, // 面向 -X
  hall: { site: [50.0, -3.5], ground: 0.45, yaw: Math.PI / 2 }, // 面向 -X
  track: { site: [0, 0], ground: 0, yaw: -Math.PI / 2 }, // 面向 +X
  bc: { site: [5.0, 88.5], ground: 0, yaw: -Math.PI / 2 }, // B/C 中庭，面向 +X
};
const SPAWN_KEYS = Object.keys(SPAWNS);
// 沉浸模式的快速移動鍵與按鈕共用；滑鼠鎖定時 HUD 收不到點擊。
const QUICK_SPAWN_KEYS = { KeyC: "bc", KeyG: "gate" };

const params = new URLSearchParams(location.search);
const initialView = VIEW_KEYS.includes(params.get("view")) ? params.get("view") : "all";
const initialAt = SPAWN_KEYS.includes(params.get("at")) ? params.get("at") : "gate";
const startWalk = params.get("mode") === "walk";
const rotateDisabled = params.get("rotate") === "0";
const debugEnabled = params.get("debug") === "1";
const touchDevice =
  window.matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints ?? 0) > 0;

let orbit = null;
let mode = "orbit";
let loaded = false;
let walkAt = initialAt;
let pendingSpawn = null;
let renderer = null;
let scene = null;
let camera = null;
let canvas = null;
let modelRoot = null;
let collision = null;
let walk = null;
let zones = null;
let zonesPromise = null;
let walkPreparing = false;
let sun = null;
let hemi = null;
let wireframe = null;

const _shadowTarget = new THREE.Vector3();

const ui = createUI({
  touch: touchDevice,
  debug: debugEnabled,
  onModeSelect: (next) => {
    if (next === "walk") enterWalk(walkAt);
    else enterOrbit();
  },
  onViewSelect: (name) => {
    if (loaded && mode === "orbit") orbit?.applyView(name);
  },
  onSpawnSelect: quickMoveTo,
  onWireframeToggle: setWireframe,
});

// 快速移動：按鈕與鍵盤共用。沉浸模式鎖定滑鼠時，HUD 收不到點擊，所以另給 C／G 鍵。
function quickMoveTo(key) {
  if (!SPAWN_KEYS.includes(key) || mode !== "walk") return;
  // BVH 還在建；先記下來，walk 準備好再跳。
  if (!walk) {
    pendingSpawn = key;
    return;
  }
  walkAt = key;
  walk.jumpTo(SPAWNS[key]);
  syncUrl();
}

init();

function init() {
  canvas = document.getElementById("scene");
  const stage = document.querySelector(".stage");
  window.addEventListener("keydown", (event) => {
    const spawn = QUICK_SPAWN_KEYS[event.code];
    if (!spawn || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
    quickMoveTo(spawn);
  });
  zonesPromise = loadZones().catch((error) => {
    console.error(error);
    return null;
  });

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch (error) {
    ui.setError("瀏覽器無法建立 WebGL 環境，請確認已啟用硬體加速。");
    console.error(error);
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    ORBIT_FOV,
    stage.clientWidth / stage.clientHeight,
    0.1,
    2000,
  );
  camera.rotation.order = "YXZ";

  // RoomEnvironment + PMREM 當環境光，接近舊頁的 neutral 環境。
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  scene.environmentIntensity = 0.3;
  room.dispose();
  pmrem.dispose();

  sun = new THREE.DirectionalLight(0xffffff, 3.4);
  sun.position.copy(SUN_TARGET).add(SUN_OFFSET);
  sun.target.position.copy(SUN_TARGET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 600;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.3;
  sun.shadow.radius = 1;
  setShadowRadius(ORBIT_SHADOW_RADIUS);
  scene.add(sun, sun.target);

  // 沉浸模式室內補光；戶外為 0，不改變鳥瞰外觀。
  hemi = new THREE.HemisphereLight(0xdce8ff, 0x585238, 0);
  scene.add(hemi);

  // 除錯／自動化測試用；不屬於 viewer 對外契約。
  window.__viewer = { renderer, scene, camera, sun, hemi };

  orbit = createOrbitView({
    camera,
    domElement: canvas,
    setExposure: (value) => {
      renderer.toneMappingExposure = value;
    },
    setEnvironmentIntensity: (value) => {
      scene.environmentIntensity = value;
    },
    onViewChange: ui.setActiveView,
  });
  orbit.setRotateDisabled(rotateDisabled);
  orbit.applyView(startWalk ? "all" : initialView, { immediate: true });

  loadModel();

  window.addEventListener("resize", resize);
  // 沉浸模式的 Esc 由 walk.js 處理（先解鎖、再回鳥瞰）；BVH 準備中則由這裡接手。
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mode === "walk" && !walk?.isEnabled()) enterOrbit();
  });

  const timer = new THREE.Timer();
  renderer.setAnimationLoop(() => {
    timer.update();
    const delta = Math.min(timer.getDelta(), 0.1);
    if (mode === "orbit") {
      orbit.update(delta);
    } else {
      walk?.update(delta);
      updateWalkScene(delta);
    }
    renderer.render(scene, camera);
  });
}

function setShadowRadius(radius) {
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -radius;
  shadowCamera.right = radius;
  shadowCamera.top = radius;
  shadowCamera.bottom = -radius;
  shadowCamera.updateProjectionMatrix();
}

function setWireframe(on) {
  if (!on) {
    if (wireframe) {
      scene.remove(wireframe);
      wireframe.geometry.dispose();
      wireframe.material.dispose();
      wireframe = null;
    }
    ui.setWireframe(false);
    return;
  }
  if (wireframe || !collision?.ready()) {
    if (!wireframe) ui.setWireframe(false);
    return;
  }
  // 只建一次；切換或離開沉浸模式時整份移除，不每幀重建。
  const geometry = new THREE.WireframeGeometry(collision.getGeometry());
  const material = new THREE.LineBasicMaterial({
    color: 0xc46a4e,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  wireframe = new THREE.LineSegments(geometry, material);
  wireframe.name = "debug_collision_wireframe";
  wireframe.frustumCulled = false;
  scene.add(wireframe);
  ui.setWireframe(true);
}

// 沉浸模式：陰影相機跟著玩家；室內平滑提高半球光與環境光。
function updateWalkScene(delta) {
  if (!walk || !sun || !hemi) return;
  _shadowTarget.set(camera.position.x, 0, camera.position.z);
  sun.target.position.copy(_shadowTarget);
  sun.position.copy(_shadowTarget).add(SUN_OFFSET);

  const inside = walk.isInterior();
  hemi.intensity = THREE.MathUtils.damp(hemi.intensity, inside ? HEMI_INTERIOR : HEMI_WALK, 2.5, delta);
  scene.environmentIntensity = THREE.MathUtils.damp(
    scene.environmentIntensity,
    inside ? 0.75 : 0.6,
    2.5,
    delta,
  );
}

// GLB 只建立一個 loader、只請求一次；失敗時由使用者重新載入頁面。
function loadModel() {
  const loader = new GLTFLoader();
  loader.load(
    "../exports/ckes_v2.glb",
    (gltf) => {
      gltf.scene.traverse((object) => {
        if (!object.isMesh) return;
        // 地面、道路、跑道是貼地的面，投影只會產生陰影瑕疵。
        object.castShadow = !/^(Ground_|Road_|Track_)/.test(object.name);
        object.receiveShadow = true;
      });
      scene.add(gltf.scene);
      modelRoot = gltf.scene;
      loaded = true;
      ui.setReady();
      if (startWalk) enterWalk(initialAt);
    },
    (event) => ui.setLoading(event),
    (error) => {
      console.error(error);
      ui.setError(
        "請確認 exports/ckes_v2.glb 存在，並在 repo 根目錄執行 make preview 後開 http://localhost:8000/viewer/。",
      );
    },
  );
}

async function enterWalk(at) {
  if (!loaded || mode === "walk" || !orbit || walkPreparing) return;
  pendingSpawn = null;
  walkAt = SPAWN_KEYS.includes(at) ? at : "gate";
  const spawn = SPAWNS[walkAt];

  orbit.saveState();
  orbit.setEnabled(false);
  mode = "walk";
  scene.environmentIntensity = 0.6;
  hemi.intensity = HEMI_WALK;
  setShadowRadius(WALK_SHADOW_RADIUS);
  _shadowTarget.set(spawn.site[0], 0, -spawn.site[1]);
  sun.target.position.copy(_shadowTarget);
  sun.position.copy(_shadowTarget).add(SUN_OFFSET);

  camera.fov = WALK_FOV;
  camera.near = 0.1;
  camera.far = 1000;
  camera.updateProjectionMatrix();
  camera.position.set(spawn.site[0], spawn.ground + EYE_HEIGHT, -spawn.site[1]);
  camera.rotation.set(0, spawn.yaw, 0);

  ui.setMode("walk");
  ui.setWalkPreparing();
  syncUrl();

  walkPreparing = true;
  try {
    // 先讓瀏覽器畫出「正在準備沉浸模式…」，再做同步的 BVH 建置。
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (mode !== "walk") return;

    if (!zones) zones = await zonesPromise;
    if (!zones) throw new Error("viewer/nav.json 載入失敗");
    if (mode !== "walk") return;

    if (!collision) {
      // three-mesh-bvh 與 collision.js 也延後到第一次進入沉浸模式才下載。
      const { createCollision } = await import("./collision.js");
      collision = createCollision({ scene: modelRoot, nav: zones.nav });
    }
    if (!collision.ready()) {
      const stats = collision.build();
      console.info(
        `[walk] BVH ${stats.triangles} triangles / ${stats.meshes} meshes / ${stats.buildMs} ms`,
      );
    }

    if (!walk) {
      walk = createWalk({
        camera,
        domElement: canvas,
        collision,
        zones,
        ui,
        onExit: enterOrbit,
      });
      if (debugEnabled) ui.setDebugReady(true);
    }
    // BVH 建置期間可能已按 Esc／模式鈕離開；不要再把 HUD 蓋回沉浸狀態。
    if (mode !== "walk") return;
    walk.enter(spawn);
    if (pendingSpawn) {
      const key = pendingSpawn;
      pendingSpawn = null;
      quickMoveTo(key);
    }
  } catch (error) {
    console.error(error);
    ui.setError("無法建立沉浸模式，請確認 viewer/nav.json 存在且格式正確。");
    enterOrbit();
  } finally {
    walkPreparing = false;
  }
}

function enterOrbit() {
  if (mode !== "walk" || !orbit) return;
  pendingSpawn = null;
  walk?.pause();
  setWireframe(false);
  mode = "orbit";
  hemi.intensity = 0;
  setShadowRadius(ORBIT_SHADOW_RADIUS);
  sun.target.position.copy(SUN_TARGET);
  sun.position.copy(SUN_TARGET).add(SUN_OFFSET);
  camera.fov = ORBIT_FOV;
  camera.updateProjectionMatrix();
  orbit.setEnabled(true);
  orbit.restoreState();
  ui.setMode("orbit");
  syncUrl();
}

function syncUrl() {
  const url = new URL(location.href);
  if (mode === "walk") {
    url.searchParams.set("mode", "walk");
    url.searchParams.set("at", walkAt);
    url.searchParams.delete("view");
  } else {
    url.searchParams.delete("mode");
    url.searchParams.delete("at");
    url.searchParams.set("view", orbit.getCurrentView());
    if (rotateDisabled) url.searchParams.set("rotate", "0");
  }
  history.replaceState(null, "", url);
}

function resize() {
  const stage = document.querySelector(".stage");
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
