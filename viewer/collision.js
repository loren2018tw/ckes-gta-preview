import * as THREE from "three";
import { MeshBVH } from "three/addons/three-mesh-bvh/index.module.js";

// 沉浸模式的碰撞：把 GLB 的可碰撞網格合併成一份世界座標幾何，建 MeshBVH。
// 物理只用這一棵 BVH；nav.json 只提供校界、梯間阻擋等少數例外。
// 座標：Three 世界 (x 東, y 上, z 南)；site frame 的 y 北 = 世界 -z。

const CAPSULE_RADIUS = 0.35;
const CAPSULE_HEIGHT = 1.75;
const EYE_HEIGHT = 1.65;
const STEP_HEIGHT = 0.35;
const EYE_SAMPLE_HEIGHTS = [0.55, 0.9, 1.25, 1.55];
const MIN_WALK_NORMAL_Y = Math.cos((40 * Math.PI) / 180);
const GRAVITY = 9.8;
const MAX_SUBSTEP = 0.05; // 遠小於 A 棟牆厚 0.18 m，5 m/s 也不會穿牆
const BASE_GROUND_Y = -0.1; // Ground_Base 頂面
const EXCLUDED_PREFIXES = ["Trees_Canopies"]; // 樹冠在頭頂，低枝會誤擋

const _box = new THREE.Box3();
const _capsuleBox = new THREE.Box3();
const _sample = new THREE.Vector3();
const _triPoint = new THREE.Vector3();
const _ray = new THREE.Ray();
const _down = new THREE.Vector3(0, -1, 0);

/**
 * 把場景中所有可碰撞 mesh 套用世界矩陣，合併成一份 position + index 幾何。
 * 只保留位置屬性，避免各 mesh 的 uv／normal 差異讓 merge 失敗。
 */
function collectGeometry(root) {
  root.updateMatrixWorld(true);
  const positions = [];
  const indices = [];
  const meshes = [];
  let vertexOffset = 0;
  let triangles = 0;

  root.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh) return;
    if (EXCLUDED_PREFIXES.some((prefix) => object.name.startsWith(prefix))) return;
    const geometry = object.geometry;
    const position = geometry?.getAttribute("position");
    if (!position) return;

    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    const vertex = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
    for (let i = 0; i < count; i += 1) {
      indices.push(vertexOffset + (index ? index.getX(i) : i));
    }
    vertexOffset += position.count;
    triangles += count / 3;
    meshes.push(object.name);
  });

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    triangles,
    meshes,
  };
}

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function signedArea(polygon) {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    area += polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y;
  }
  return area / 2;
}

/**
 * 膠囊碰撞與可行走範圍。
 *
 * @param {object} options
 * @param {THREE.Object3D} options.scene 已載入的 GLB 根節點（世界矩陣需正確）
 * @param {object|null} options.nav viewer/nav.json（boundary 與 blockers；可省略）
 * @returns {{
 *   ready(): boolean,
 *   build(): object,
 *   move(delta: {x:number,z:number}, dt:number): object,
 *   teleport(siteX:number, siteY:number, groundHint?:number): object,
 *   sample(): object,
 *   radius: number,
 *   height: number,
 *   eyeHeight: number,
 * }}
 */
export function createCollision({ scene, nav = null }) {
  const position = new THREE.Vector3(0, 0, 0); // 腳底位置（x, y=feetY, z）
  let feetY = 0;
  let verticalVelocity = 0;
  let grounded = false;
  let blocked = null;
  let groundY = 0;
  let bvh = null;
  let geometry = null;
  let stats = null;

  const boundary = nav?.boundary?.polygon?.length
    ? nav.boundary.polygon.map(([x, y]) => new THREE.Vector2(x, -y))
    : null;

  // nav 的 AABB 用 site (x, y)；轉成世界 x/z，y 保留為高度範圍。
  const blockers = (nav?.blockers ?? []).map((blocker) => {
    const [x0, y0, x1, y1] = blocker.aabb;
    return {
      id: blocker.id,
      name: blocker.name_zh ?? blocker.id,
      minX: Math.min(x0, x1),
      maxX: Math.max(x0, x1),
      minZ: -Math.max(y0, y1),
      maxZ: -Math.min(y0, y1),
      minY: Number(blocker.z0 ?? 0),
      maxY: Number(blocker.z1 ?? CAPSULE_HEIGHT),
    };
  });

  function build() {
    if (bvh) return stats;
    const started = performance.now();
    const merged = collectGeometry(scene);
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(merged.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(merged.indices, 1));
    bvh = new MeshBVH(geometry, { maxLeafTris: 10 });

    stats = {
      triangles: merged.triangles,
      meshes: merged.meshes.length,
      vertices: merged.positions.length / 3,
      buildMs: Math.round(performance.now() - started),
    };
    return stats;
  }

  function castGround(x, z, originY, maxY) {
    _ray.origin.set(x, originY, z);
    _ray.direction.copy(_down);
    const hits = bvh.raycast(_ray, THREE.DoubleSide, 0, 80);
    hits.sort((a, b) => a.distance - b.distance);
    for (const hit of hits) {
      const normalY = Math.abs(hit.face?.normal?.y ?? 0);
      if (normalY < MIN_WALK_NORMAL_Y) continue;
      if (hit.point.y > maxY) continue;
      return hit;
    }
    return null;
  }

  function groundBelow(x, z) {
    // 從腳底上方 0.5 m 往下射，能涵蓋 0.35 m 的踏階與自由落體。
    return castGround(
      x,
      z,
      feetY + STEP_HEIGHT + 0.15,
      feetY + STEP_HEIGHT + 0.001,
    );
  }

  /** 回傳是否仍有穿透；把最近的推擠量寫進 position。 */
  function resolveWalls() {
    _capsuleBox.min.set(
      position.x - CAPSULE_RADIUS,
      feetY + STEP_HEIGHT,
      position.z - CAPSULE_RADIUS,
    );
    _capsuleBox.max.set(
      position.x + CAPSULE_RADIUS,
      feetY + CAPSULE_HEIGHT,
      position.z + CAPSULE_RADIUS,
    );

    let sumX = 0;
    let sumZ = 0;
    let maxDepth = 0;

    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_capsuleBox),
      intersectsTriangle: (triangle) => {
        let deepest = 0;
        let pushX = 0;
        let pushZ = 0;
        for (const height of EYE_SAMPLE_HEIGHTS) {
          _sample.set(position.x, feetY + height, position.z);
          triangle.closestPointToPoint(_sample, _triPoint);
          // 踏階（≤ 0.35 m）交給向下射線；天花板不在膠囊高度內。
          if (_triPoint.y <= feetY + STEP_HEIGHT + 0.0001) continue;
          if (_triPoint.y >= feetY + CAPSULE_HEIGHT) continue;
          const dx = position.x - _triPoint.x;
          const dz = position.z - _triPoint.z;
          const distanceSq = dx * dx + dz * dz;
          if (distanceSq >= CAPSULE_RADIUS * CAPSULE_RADIUS) continue;
          const distance = Math.sqrt(distanceSq);
          const depth = CAPSULE_RADIUS - distance;
          if (depth > deepest) {
            deepest = depth;
            if (distance > 1e-5) {
              pushX = (dx / distance) * depth;
              pushZ = (dz / distance) * depth;
            } else {
              // 正好在三角形上方：用水平法線推出。
              const n = triangle.getNormal(new THREE.Vector3());
              const length = Math.hypot(n.x, n.z) || 1;
              pushX = (n.x / length) * depth;
              pushZ = (n.z / length) * depth;
            }
          }
        }
        if (deepest > 0) {
          maxDepth = Math.max(maxDepth, deepest);
          sumX += pushX;
          sumZ += pushZ;
        }
      },
    });

    const length = Math.hypot(sumX, sumZ);
    if (length < 1e-6) return false;
    // 內角同時碰到兩面牆時，合向量可能過長；縮到最深穿透量即可。
    const scale = Math.min(1, maxDepth / length);
    position.x += sumX * scale;
    position.z += sumZ * scale;
    return true;
  }

  function resolveBlockers() {
    let hitBlocker = null;
    for (const blocker of blockers) {
      if (feetY + CAPSULE_HEIGHT < blocker.minY || feetY > blocker.maxY) continue;
      const minX = blocker.minX - CAPSULE_RADIUS;
      const maxX = blocker.maxX + CAPSULE_RADIUS;
      const minZ = blocker.minZ - CAPSULE_RADIUS;
      const maxZ = blocker.maxZ + CAPSULE_RADIUS;
      if (position.x <= minX || position.x >= maxX) continue;
      if (position.z <= minZ || position.z >= maxZ) continue;

      const pushWest = position.x - minX;
      const pushEast = maxX - position.x;
      const pushSouth = position.z - minZ;
      const pushNorth = maxZ - position.z;
      const smallest = Math.min(pushWest, pushEast, pushSouth, pushNorth);
      // 往最近的出口推；梯間第一階的 AABB 就是靠這個隱形牆擋住上樓。
      if (smallest === pushWest) position.x = minX - 1e-4;
      else if (smallest === pushEast) position.x = maxX + 1e-4;
      else if (smallest === pushSouth) position.z = minZ - 1e-4;
      else position.z = maxZ + 1e-4;
      hitBlocker = blocker;
    }
    return hitBlocker;
  }

  function nearestInside(x, z) {
    let best = null;
    let bestDistanceSq = Infinity;
    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i, i += 1) {
      const a = boundary[j];
      const b = boundary[i];
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const lengthSq = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.y) * dz) / lengthSq));
      const px = a.x + dx * t;
      const pz = a.y + dz * t;
      const distanceSq = (x - px) ** 2 + (z - pz) ** 2;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = { x: px, z: pz, dx, dz, lengthSq };
      }
    }
    if (!best) return null;

    const ccw = signedArea(boundary) > 0;
    let nx = ccw ? -best.dz : best.dz;
    let nz = ccw ? best.dx : -best.dx;
    const length = Math.hypot(nx, nz) || 1;
    nx /= length;
    nz /= length;
    for (const inset of [CAPSULE_RADIUS + 0.05, 0.5, 1.0, 2.0]) {
      const candidate = new THREE.Vector2(best.x + nx * inset, best.z + nz * inset);
      if (pointInPolygon(candidate.x, candidate.y, boundary)) return candidate;
    }
    return new THREE.Vector2(best.x, best.z);
  }

  function clampBoundary(startX, startZ) {
    if (!boundary) return false;
    if (pointInPolygon(position.x, position.z, boundary)) return false;
    if (pointInPolygon(startX, startZ, boundary)) {
      // 從上一格（界內）到這一格（界外）之間二分搜尋，停在邊界內側。
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 20; i += 1) {
        const mid = (lo + hi) / 2;
        const x = startX + (position.x - startX) * mid;
        const z = startZ + (position.z - startZ) * mid;
        if (pointInPolygon(x, z, boundary)) lo = mid;
        else hi = mid;
      }
      position.x = startX + (position.x - startX) * lo;
      position.z = startZ + (position.z - startZ) * lo;
    } else {
      const inside = nearestInside(position.x, position.z);
      if (inside) {
        position.x = inside.x;
        position.z = inside.y;
      }
    }
    blocked = "boundary";
    return true;
  }

  function updateVertical(dt) {
    const hit = groundBelow(position.x, position.z);
    const top = hit ? hit.point.y : null;
    if (top !== null) {
      groundY = top;
      if (top >= feetY - 0.001) {
        feetY = top;
        verticalVelocity = 0;
        grounded = true;
      } else if (grounded && feetY - top <= STEP_HEIGHT) {
        // 下階：≤ 0.35 m 直接貼地，避免每階都短暫騰空。
        feetY = top;
        verticalVelocity = 0;
        grounded = true;
      } else {
        grounded = false;
        verticalVelocity -= GRAVITY * dt;
        feetY += verticalVelocity * dt;
        if (feetY <= top) {
          feetY = top;
          verticalVelocity = 0;
          grounded = true;
        }
      }
    } else {
      grounded = false;
      verticalVelocity -= GRAVITY * dt;
      feetY += verticalVelocity * dt;
    }

    if (feetY < BASE_GROUND_Y) {
      feetY = BASE_GROUND_Y;
      verticalVelocity = 0;
      grounded = true;
    }
    position.y = feetY;
  }

  function move(delta, dt) {
    if (!bvh) return sample();
    blocked = null;
    const dx = Number(delta?.x) || 0;
    const dz = Number(delta?.z) || 0;
    const distance = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(distance / MAX_SUBSTEP));

    for (let step = 0; step < steps; step += 1) {
      const startX = position.x;
      const startZ = position.z;
      position.x += dx / steps;
      position.z += dz / steps;

      for (let iteration = 0; iteration < 8; iteration += 1) {
        if (!resolveWalls()) break;
      }
      const blocker = resolveBlockers();
      if (blocker) blocked = blocker.id;
      for (let iteration = 0; iteration < 4; iteration += 1) {
        if (!resolveWalls()) break;
      }
      clampBoundary(startX, startZ);
    }

    updateVertical(dt);
    return sample();
  }

  function teleport(siteX, siteY, groundHint = 0) {
    position.set(Number(siteX) || 0, 0, -(Number(siteY) || 0));
    blocked = null;
    verticalVelocity = 0;

    let hit = null;
    if (bvh) {
      // 從出生點預期高度上方 2.5 m 往下找地板；不設上限，避免樓層板被舊的腳底高度濾掉。
      const origin = Number(groundHint) + 2.5;
      hit = castGround(position.x, position.z, origin, origin);
      if (!hit) hit = castGround(position.x, position.z, 50, 50);
    }
    feetY = hit ? hit.point.y : Number(groundHint) || 0;
    groundY = feetY;
    grounded = Boolean(hit);
    position.y = feetY;

    if (bvh) {
      for (let iteration = 0; iteration < 8; iteration += 1) {
        if (!resolveWalls()) break;
      }
      resolveBlockers();
      clampBoundary(position.x, position.z);
    }
    return sample();
  }

  function sample() {
    return {
      ready: Boolean(bvh),
      siteX: position.x,
      siteY: -position.z,
      x: position.x,
      z: position.z,
      feetY,
      groundY,
      eyeY: feetY + EYE_HEIGHT,
      grounded,
      blocked,
      triangles: stats?.triangles ?? 0,
      meshes: stats?.meshes ?? 0,
      buildMs: stats?.buildMs ?? 0,
    };
  }

  return {
    ready: () => Boolean(bvh),
    build,
    move,
    teleport,
    sample,
    // 只給 ?debug=1 的碰撞線框使用；不改動碰撞本身。
    getGeometry: () => geometry,
    radius: CAPSULE_RADIUS,
    height: CAPSULE_HEIGHT,
    eyeHeight: EYE_HEIGHT,
  };
}
