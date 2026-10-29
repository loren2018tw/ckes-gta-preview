import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const DEG = Math.PI / 180;

// 六個永久視角。數值沿用舊頁的 camera-orbit="theta phi radius"：
// theta 是繞 Y 軸的方位角（0 面向 +Z），phi 是自 +Y 起算的極角。
// target 與 radius 不變，只把球座標換成 Three.js 的相機位置。
export const VIEWS = {
  all: { label: "全校", target: [0, 5, 0], theta: 35, phi: 52, radius: 300, rotate: true, exposure: 1.0, env: 0.3 },
  "a": { label: "A 棟", target: [45, 8, 2], theta: 40, phi: 58, radius: 120, rotate: false, exposure: 1.0, env: 0.3 },
  "b": { label: "B 棟", target: [10.6, 6, -80.6], theta: 20, phi: 55, radius: 110, rotate: false, exposure: 1.0, env: 0.3 },
  "track": { label: "操場", target: [0, 0, 0], theta: 30, phi: 42, radius: 170, rotate: false, exposure: 1.0, env: 0.3 },
  "court": { label: "風雨球場", target: [-56.8, 4, -14.2], theta: 65, phi: 48, radius: 140, rotate: false, exposure: 1.0, env: 0.3 },
  // 以下六個是舊連結的永久 key，不再放按鈕；不要移除或改名。
  gate: { label: "正門", target: [82.5, 2, 0], theta: 90, phi: 74, radius: 26, rotate: false, exposure: 1.0, env: 0.3 },
  "a-east": { label: "A 棟東", target: [55.7, 9, -2], theta: 90, phi: 72, radius: 32, rotate: false, exposure: 1.0, env: 0.3 },
  "a-west": { label: "A 棟西", target: [40, 7, 0], theta: 270, phi: 72, radius: 55, rotate: false, exposure: 1.0, env: 0.3 },
  "a-south": { label: "A 棟南", target: [45, 9, 45], theta: 0, phi: 72, radius: 32, rotate: false, exposure: 1.0, env: 0.3 },
  // 1F 是半室內走廊，曝光固定 0.55，需要較高的環境光才看得清楚。
  "a-1f": { label: "A 棟 1F", target: [41.45, 1.5, -30], theta: 0, phi: 89, radius: 65, rotate: false, exposure: 0.55, env: 0.9 },
};

const AUTO_ROTATE_RESUME_MS = 2500;
const AUTO_ROTATE_SPEED = 1; // OrbitControls 的 1 = 6°/s
const VIEW_TWEEN_SECONDS = 0.65;

// 舊頁 max-camera-orbit="auto 88deg auto"；a-1f 的 89° 會被夾到 88°。
const MAX_POLAR_ANGLE = 88 * DEG;

function showView(view) {
  const target = new THREE.Vector3(...view.target);
  const phi = Math.min(view.phi, MAX_POLAR_ANGLE / DEG) * DEG;
  const theta = view.theta * DEG;
  const position = new THREE.Vector3()
    .setFromSphericalCoords(view.radius, phi, theta)
    .add(target);
  return { target, position };
}

/**
 * 鳥瞰相機：六個預設視角、OrbitControls、自動旋轉與視角切換動畫。
 * 沉浸模式期間以 setEnabled(false) 停用，不動相機。
 */
export function createOrbitView({ camera, domElement, setExposure, setEnvironmentIntensity, onViewChange }) {
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = 0.4; // 對應舊頁 zoom-sensitivity="0.4"
  controls.minDistance = 4;
  controls.maxPolarAngle = MAX_POLAR_ANGLE;
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED;

  let enabled = true;
  let rotateDisabled = false;
  let wantsRotate = true;
  let currentView = "all";
  let exposure = 1.0;
  let envIntensity = 0.3;
  let resumeTimer = 0;
  let tween = null;
  let saved = null;

  function clearResumeTimer() {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = 0;
    }
  }

  function scheduleResume() {
    clearResumeTimer();
    if (!enabled || !wantsRotate || rotateDisabled) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = 0;
      if (enabled && wantsRotate && !rotateDisabled && !tween) {
        controls.autoRotate = true;
      }
    }, AUTO_ROTATE_RESUME_MS);
  }

  // 互動開始先停自動旋轉；結束後等 2.5 秒再恢復。
  controls.addEventListener("start", () => {
    clearResumeTimer();
    controls.autoRotate = false;
  });
  controls.addEventListener("end", scheduleResume);

  function applyExposure(value) {
    exposure = value ?? 1.0;
    setExposure(exposure);
  }

  function applyEnvironment(value) {
    envIntensity = value ?? 0.3;
    setEnvironmentIntensity(envIntensity);
  }

  // 依軌道半徑調整裁切面，維持 far/near = 1000；固定的 0.1/2000 會讓
  // 地面分層在遠處 z-fighting。
  function updateClipPlanes() {
    const radius = Math.max(camera.position.distanceTo(controls.target), 4);
    const far = Math.max(600, radius * 2);
    const near = Math.max(0.1, far / 1000);
    if (camera.far !== far || camera.near !== near) {
      camera.far = far;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  }

  function applyView(name, { immediate = false } = {}) {
    if (!VIEWS[name]) return;
    currentView = name;
    clearResumeTimer();
    const view = VIEWS[name];
    const { target, position } = showView(view);

    wantsRotate = view.rotate && !rotateDisabled;
    controls.autoRotate = false;
    applyExposure(view.exposure);
    applyEnvironment(view.env);
    onViewChange?.(name);

    if (immediate || !enabled) {
      tween = null;
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
      updateClipPlanes();
      controls.autoRotate = enabled && wantsRotate;
      return;
    }

    tween = {
      elapsed: 0,
      fromPosition: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPosition: position,
      toTarget: target,
    };
    controls.enabled = false;
  }

  function setEnabled(value) {
    enabled = value;
    clearResumeTimer();
    controls.enabled = value && !tween;
    controls.autoRotate = value && wantsRotate && !rotateDisabled && !tween;
  }

  function setRotateDisabled(value) {
    rotateDisabled = value;
    clearResumeTimer();
    controls.autoRotate = enabled && wantsRotate && !rotateDisabled && !tween;
  }

  function saveState() {
    saved = {
      position: camera.position.clone(),
      target: controls.target.clone(),
      view: currentView,
      wantsRotate,
      exposure,
      envIntensity,
    };
  }

  function restoreState() {
    if (!saved) {
      applyView("all", { immediate: true });
      return;
    }
    tween = null;
    currentView = saved.view;
    wantsRotate = saved.wantsRotate;
    camera.position.copy(saved.position);
    controls.target.copy(saved.target);
    controls.enabled = true;
    controls.update();
    updateClipPlanes();
    controls.autoRotate = wantsRotate && !rotateDisabled;
    applyExposure(saved.exposure);
    applyEnvironment(saved.envIntensity);
    onViewChange?.(currentView);
  }

  function update(delta) {
    if (tween) {
      tween.elapsed += delta;
      const k = Math.min(1, tween.elapsed / VIEW_TWEEN_SECONDS);
      const eased = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
      camera.lookAt(controls.target);
      updateClipPlanes();
      if (k >= 1) {
        tween = null;
        controls.enabled = enabled;
        controls.update();
        updateClipPlanes();
        controls.autoRotate = enabled && wantsRotate && !rotateDisabled;
      }
      return;
    }
    controls.update(delta);
    updateClipPlanes();
  }

  return {
    applyView,
    setEnabled,
    setRotateDisabled,
    saveState,
    restoreState,
    update,
    getCurrentView: () => currentView,
  };
}
