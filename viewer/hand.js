import * as THREE from "three";

// 沉浸模式的第一人稱右手：低多邊形方塊手臂，掛在相機底下。
// app.js 會把相機加進 scene，相機子物件才會被渲染；這隻手不進 GLB、也不進碰撞。

const SKIN = 0xc98f6b;
const SKIN_LIGHT = 0xd9a37c;
const SKIN_DARK = 0xa87354;

// 相機座標：+x 右、+y 上、-z 前方。手從畫面上方出現、往下打，打完淡出並隱藏。
const START_POSE = {
  position: new THREE.Vector3(0.4, 0.78, -0.78),
  rotation: new THREE.Euler(-1.15, -0.32, 0.12),
  scale: 1,
};
const IMPACT_POSE = {
  position: new THREE.Vector3(0.3, -0.3, -0.78),
  rotation: new THREE.Euler(0.06, -0.3, 0.08),
  scale: 1.18,
};

const PUNCH_DOWN = 0.09;
const PUNCH_HOLD = 0.04;
const PUNCH_FADE = 0.11;
const PUNCH_TOTAL = PUNCH_DOWN + PUNCH_HOLD + PUNCH_FADE;

// 直式螢幕的水平視角較窄；把手往中央收並縮小，避免整隻手臂蓋住畫面。
const REFERENCE_ASPECT = 1.6;

function aspectFit(camera) {
  const aspect = Number(camera.aspect) || REFERENCE_ASPECT;
  const ratio = aspect / REFERENCE_ASPECT;
  return {
    x: THREE.MathUtils.clamp(ratio, 0.35, 1),
    size: THREE.MathUtils.clamp(Math.sqrt(ratio), 0.55, 1),
  };
}

function easeInCubic(t) {
  return t * t * t;
}

function makeMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
    emissive: color,
    emissiveIntensity: 0.18,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

function box(width, height, depth, material, x, y, z, order) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  // 前景武器／手：最後畫、不寫深度，貼牆時也不會被吃掉。
  // depthTest 關閉後，同一隻手內以 renderOrder 由遠到近疊。
  mesh.renderOrder = order;
  return mesh;
}

/**
 * 建立第一人稱右手。回傳的 API 由 walk.js 呼叫。
 *
 * @param {THREE.Camera} camera
 */
export function createHand(camera) {
  const group = new THREE.Group();
  group.name = "viewmodel_hand";
  group.visible = false;

  const skin = makeMaterial(SKIN);
  const skinLight = makeMaterial(SKIN_LIGHT);
  const skinDark = makeMaterial(SKIN_DARK);
  const materials = [skin, skinLight, skinDark];

  // 前臂（靠近鏡頭）、上臂、拳頭；拳頭朝 -z，出拳時一起往前。
  group.add(box(0.15, 0.15, 0.32, skin, 0, 0, 0.1, 14));
  group.add(box(0.16, 0.16, 0.14, skin, 0, 0, 0.29, 15));
  group.add(box(0.21, 0.18, 0.18, skinLight, 0, 0, -0.16, 10));

  // 四指彎在拳頭上緣，指節用深一階的膚色。
  for (let i = 0; i < 4; i += 1) {
    const x = -0.069 + i * 0.046;
    group.add(box(0.036, 0.06, 0.11, skin, x, 0.095, -0.2, 11));
    group.add(box(0.036, 0.026, 0.045, skinDark, x, 0.112, -0.245, 12));
  }

  // 拇指在拳頭左側。
  group.add(box(0.06, 0.085, 0.115, skin, -0.115, -0.005, -0.17, 12));
  group.add(box(0.06, 0.03, 0.05, skinDark, -0.115, 0.045, -0.215, 13));

  camera.add(group);

  let active = false;
  let punchTime = -1;

  function applyPose(from, to, t) {
    const fit = aspectFit(camera);
    group.position.lerpVectors(from.position, to.position, t);
    group.position.x *= fit.x;
    group.rotation.set(
      THREE.MathUtils.lerp(from.rotation.x, to.rotation.x, t),
      THREE.MathUtils.lerp(from.rotation.y, to.rotation.y, t),
      THREE.MathUtils.lerp(from.rotation.z, to.rotation.z, t),
    );
    group.scale.setScalar(THREE.MathUtils.lerp(from.scale, to.scale, t) * fit.size);
  }

  function setOpacity(value) {
    const opacity = THREE.MathUtils.clamp(value, 0, 1);
    for (const material of materials) material.opacity = opacity;
  }

  function applyTime(time) {
    if (time < PUNCH_DOWN) {
      applyPose(START_POSE, IMPACT_POSE, easeInCubic(time / PUNCH_DOWN));
      setOpacity(1);
      return;
    }
    applyPose(IMPACT_POSE, IMPACT_POSE, 0);
    const afterHold = time - PUNCH_DOWN - PUNCH_HOLD;
    setOpacity(afterHold <= 0 ? 1 : 1 - afterHold / PUNCH_FADE);
  }

  // 沒出拳時完全隱藏；只有沉浸模式（active）且右鍵動畫中才顯示。
  function hide() {
    punchTime = -1;
    group.visible = false;
    applyPose(START_POSE, START_POSE, 0);
    setOpacity(1);
  }

  function setActive(value) {
    active = Boolean(value);
    if (!active) hide();
  }

  // 右鍵出拳：一次按一下；動畫中再按不重新排隊，避免抽動。
  function punch() {
    if (!active || punchTime >= 0) return false;
    punchTime = 0;
    group.visible = true;
    applyPose(START_POSE, START_POSE, 0);
    setOpacity(1);
    return true;
  }

  function update(dt) {
    if (!active || punchTime < 0) return;
    punchTime += dt;
    if (punchTime >= PUNCH_TOTAL) {
      hide();
      return;
    }
    applyTime(punchTime);
  }

  hide();

  return {
    setActive,
    punch,
    update,
    reset: hide,
    isActive: () => active,
    isVisible: () => group.visible,
    isPunching: () => punchTime >= 0,
  };
}
