import * as THREE from "three";
import { zoneLabel } from "./zones.js";

// 第一人稱控制器：桌面 WASD＋Shift＋滑鼠鎖定／拖曳，觸控用左下搖桿＋右側拖曳。
// 碰撞與 ground/teleport API 由 collision.js 提供；這裡只產生水平位移與視角。

const WALK_SPEED = 2.2;
const RUN_SPEED = 5.0;
const LOOK_SENSITIVITY = 0.0025;
const KEY_TURN_SPEED = 1.8;
const PITCH_LIMIT = (85 * Math.PI) / 180;
const CLICK_LOCK_MAX_MOVE = 6; // 拖曳超過 6 px 視為轉頭，不觸發滑鼠鎖定
const ESC_UNLOCK_GUARD_MS = 400; // 瀏覽器用 Esc 解鎖時不再同時回鳥瞰
const JOY_DEAD_ZONE = 0.15; // 搖桿死區：半徑 15% 內不走
const JOY_WALK_AT = 0.5; // 死區後行程一半＝步行 2.2 m/s，外緣＝跑 5.0 m/s

const _input = { forward: 0, strafe: 0, speed: 0 };
const _moveDelta = { x: 0, z: 0 };

const MOVE_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ShiftLeft",
  "ShiftRight",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/**
 * @param {object} options
 * @param {THREE.PerspectiveCamera} options.camera
 * @param {HTMLElement} options.domElement
 * @param {ReturnType<import("./collision.js").createCollision>} options.collision
 * @param {Awaited<ReturnType<import("./zones.js").loadZones>>} options.zones
 * @param {ReturnType<import("./ui.js").createUI>} options.ui
 * @param {() => void} [options.onExit] Esc 且未鎖定時回鳥瞰
 */
export function createWalk({ camera, domElement, collision, zones, ui, onExit }) {
  const joystick = document.getElementById("joystick");
  const joystickKnob = document.getElementById("joystick-knob");

  const keys = new Set();
  let enabled = false;
  let yaw = 0;
  let pitch = 0;
  let locked = false;
  let hasLockedOnce = false;
  let unlockedAt = -Infinity;

  // 滑鼠拖曳（未鎖定時）與觸控看視角都只追一個 pointerId，避免多指互搶。
  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragMoved = 0;
  let lookPointerId = null;
  let lastPointerX = 0;
  let lastPointerY = 0;

  let joyPointerId = null;
  let joyRadius = 36;
  let joyCenterX = 0;
  let joyCenterY = 0;
  let joyX = 0;
  let joyY = 0;
  let joyMagnitude = 0;

  let lastZoneId = null;
  let lastLabel = "";
  let lastBlocked = null;
  let currentZone = null;
  let interior = false;

  let debugFrames = 0;
  let debugLast = 0;
  let fpsSmoothed = 0;
  let blockedReason = null;
  let blockedAt = -Infinity;

  function updateCamera(sample) {
    camera.position.set(sample.x, sample.eyeY, sample.z);
    camera.rotation.set(pitch, yaw, 0);
  }

  function hudLabel(zone) {
    let label = zoneLabel(zone);
    // 梯間第一階被 nav blocker 擋住，HUD 說明原因。
    if (zone?.kind === "interior" && /stair/.test(zone.id ?? "")) {
      label += "（2F 未建）";
    }
    return label;
  }

  function updateHud(sample) {
    const zone = zones.zoneAt(sample.siteX, sample.siteY);
    currentZone = zone;
    interior = zone.kind === "interior";
    const label = hudLabel(zone);
    if (zone.id !== lastZoneId || label !== lastLabel || sample.blocked !== lastBlocked) {
      lastZoneId = zone.id;
      lastLabel = label;
      lastBlocked = sample.blocked;
      ui.setWalkStatus(label);
    }
  }

  function updateDebug(sample) {
    if (!ui.isDebug()) return;
    debugFrames += 1;
    const now = performance.now();
    const elapsed = (now - debugLast) / 1000;
    if (elapsed < 0.25) return;
    const fps = debugFrames / elapsed;
    fpsSmoothed = fpsSmoothed ? fpsSmoothed * 0.7 + fps * 0.3 : fps;
    debugFrames = 0;
    debugLast = now;
    if (sample.blocked) {
      blockedReason = sample.blocked;
      blockedAt = now;
    }
    // 撞到東西後保留 1.5 秒，停下時還看得見原因。
    const blocked = sample.blocked ?? (now - blockedAt < 1500 ? blockedReason : null);
    ui.setDebugInfo({
      fps: fpsSmoothed,
      siteX: sample.siteX,
      siteY: sample.siteY,
      feetY: sample.feetY,
      zoneId: currentZone?.id ?? "campus",
      blocked,
    });
  }

  function isTyping(event) {
    const tag = event.target?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable;
  }

  function setLookingState() {
    ui.setLooking(locked || lookPointerId !== null);
  }

  function showLockPrompt() {
    ui.setLockPrompt(!ui.isTouch() && enabled && hasLockedOnce && !locked);
  }

  function onLockChange() {
    locked = document.pointerLockElement === domElement;
    ui.setLocked(locked);
    if (locked) {
      hasLockedOnce = true;
      ui.setLockPrompt(false);
    } else {
      unlockedAt = performance.now();
      showLockPrompt();
    }
    setLookingState();
    ui.noteActivity();
  }

  function requestLock() {
    if (locked || !enabled) return;
    try {
      const result = domElement.requestPointerLock?.();
      result?.catch?.(() => {});
    } catch {
      // 不支援滑鼠鎖定的瀏覽器仍可用拖曳轉頭。
    }
  }

  function applyLook(dx, dy) {
    yaw -= dx * LOOK_SENSITIVITY;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - dy * LOOK_SENSITIVITY));
  }

  function onKeyDown(event) {
    if (!enabled || isTyping(event)) return;
    if (event.key === "Escape") {
      if (document.pointerLockElement === domElement) {
        document.exitPointerLock?.();
        return;
      }
      // 瀏覽器處理 Esc 解鎖時可能也送出 keydown；剛解鎖的這一下只解除鎖定。
      if (performance.now() - unlockedAt < ESC_UNLOCK_GUARD_MS) return;
      onExit?.();
      return;
    }
    if (event.code === "KeyB" && ui.isDebug() && !event.repeat) {
      ui.toggleWireframe();
      return;
    }
    if (MOVE_KEYS.has(event.code)) {
      keys.add(event.code);
      if (event.code.startsWith("Arrow")) event.preventDefault();
    }
    ui.noteActivity();
  }

  function onKeyUp(event) {
    keys.delete(event.code);
  }

  function onBlur() {
    keys.clear();
    dragPointerId = null;
    lookPointerId = null;
    resetJoystick();
    setLookingState();
  }

  function onPointerDown(event) {
    if (!enabled) return;
    ui.noteActivity();

    if (event.pointerType === "mouse") {
      if (locked) return;
      dragPointerId = event.pointerId;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragMoved = 0;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      domElement.setPointerCapture?.(event.pointerId);
      return;
    }

    // 觸控／筆：第一個落在 canvas 的手指負責轉頭，其他手指不搶。
    if (lookPointerId === null) {
      lookPointerId = event.pointerId;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      domElement.setPointerCapture?.(event.pointerId);
      setLookingState();
    }
  }

  function onPointerMove(event) {
    if (!enabled) return;
    ui.noteActivity();

    if (locked) {
      applyLook(event.movementX ?? 0, event.movementY ?? 0);
      return;
    }
    if (event.pointerId !== dragPointerId && event.pointerId !== lookPointerId) return;

    const dx = event.clientX - lastPointerX;
    const dy = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    if (event.pointerId === dragPointerId) dragMoved += Math.abs(dx) + Math.abs(dy);
    applyLook(dx, dy);
  }

  function onPointerUp(event) {
    if (event.pointerId === dragPointerId) {
      const moved = Math.max(dragMoved, Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY));
      dragPointerId = null;
      domElement.releasePointerCapture?.(event.pointerId);
      if (event.pointerType === "mouse" && event.button === 0 && moved < CLICK_LOCK_MAX_MOVE) {
        requestLock();
      }
    }
    if (event.pointerId === lookPointerId) {
      lookPointerId = null;
      domElement.releasePointerCapture?.(event.pointerId);
      setLookingState();
    }
  }

  function resetJoystick() {
    joyPointerId = null;
    joyX = 0;
    joyY = 0;
    joyMagnitude = 0;
    joystick?.classList.remove("is-active");
    if (joystickKnob) joystickKnob.style.transform = "translate(0px, 0px)";
  }

  function updateJoystick(event) {
    const dx = event.clientX - joyCenterX;
    const dy = event.clientY - joyCenterY;
    const length = Math.hypot(dx, dy);
    const clamped = Math.min(length, joyRadius);
    const nx = length > 0 ? dx / length : 0;
    const ny = length > 0 ? dy / length : 0;
    joyX = nx * (clamped / joyRadius);
    joyY = ny * (clamped / joyRadius);
    joyMagnitude = clamped / joyRadius;
    if (joystickKnob) {
      joystickKnob.style.transform = `translate(${(nx * clamped).toFixed(1)}px, ${(ny * clamped).toFixed(1)}px)`;
    }
  }

  function onJoystickDown(event) {
    if (!enabled || joyPointerId !== null) return;
    const rect = joystick.getBoundingClientRect();
    joyCenterX = rect.left + rect.width / 2;
    joyCenterY = rect.top + rect.height / 2;
    const knobWidth = joystickKnob?.offsetWidth || rect.width * 0.4;
    joyRadius = Math.max(20, (rect.width - knobWidth) / 2);
    joyPointerId = event.pointerId;
    joystick.setPointerCapture?.(event.pointerId);
    joystick.classList.add("is-active");
    updateJoystick(event);
    ui.noteActivity();
    event.preventDefault();
  }

  function onJoystickMove(event) {
    if (event.pointerId !== joyPointerId) return;
    updateJoystick(event);
    event.preventDefault();
  }

  function onJoystickUp(event) {
    if (event.pointerId !== joyPointerId) return;
    joystick.releasePointerCapture?.(event.pointerId);
    resetJoystick();
  }

  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("pointerlockchange", onLockChange);
  joystick?.addEventListener("pointerdown", onJoystickDown);
  joystick?.addEventListener("pointermove", onJoystickMove);
  joystick?.addEventListener("pointerup", onJoystickUp);
  joystick?.addEventListener("pointercancel", onJoystickUp);

  function joystickSpeed() {
    if (joyMagnitude <= JOY_DEAD_ZONE) return 0;
    const t = (joyMagnitude - JOY_DEAD_ZONE) / (1 - JOY_DEAD_ZONE);
    // 一半出力＝步行速度，外緣＝跑；中間線性。
    if (t <= JOY_WALK_AT) return WALK_SPEED * (t / JOY_WALK_AT);
    return WALK_SPEED + (RUN_SPEED - WALK_SPEED) * ((t - JOY_WALK_AT) / (1 - JOY_WALK_AT));
  }

  function moveVector() {
    let forward = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
    let strafe = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    let speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;

    if (joyPointerId !== null) {
      if (joyMagnitude <= JOY_DEAD_ZONE) return null;
      forward = -joyY;
      strafe = joyX;
      speed = joystickSpeed();
    }
    if (!forward && !strafe) return null;

    const length = Math.hypot(forward, strafe) || 1;
    _input.forward = forward / length;
    _input.strafe = strafe / length;
    _input.speed = speed;
    return _input;
  }

  function update(dt) {
    if (!enabled || !collision.ready()) return;

    const turn = (keys.has("ArrowLeft") ? 1 : 0) - (keys.has("ArrowRight") ? 1 : 0);
    const tilt = (keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0);
    if (turn || tilt) {
      yaw += turn * KEY_TURN_SPEED * dt;
      pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch + tilt * KEY_TURN_SPEED * dt));
    }

    const input = moveVector();
    let sample;
    if (input) {
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      // yaw=0 面向 -Z；正向為 (-sin, -cos)，右向為 (cos, -sin)。
      _moveDelta.x = (-sin * input.forward + cos * input.strafe) * input.speed * dt;
      _moveDelta.z = (-cos * input.forward - sin * input.strafe) * input.speed * dt;
      sample = collision.move(_moveDelta, dt);
      ui.noteActivity();
    } else {
      _moveDelta.x = 0;
      _moveDelta.z = 0;
      sample = collision.move(_moveDelta, dt);
    }

    updateCamera(sample);
    updateHud(sample);
    updateDebug(sample);
  }

  function enter(spawn) {
    if (document.pointerLockElement === domElement) document.exitPointerLock?.();
    collision.teleport(spawn.site[0], spawn.site[1], spawn.ground ?? 0);
    yaw = spawn.yaw ?? 0;
    pitch = 0;
    enabled = true;
    keys.clear();
    resetJoystick();
    dragPointerId = null;
    lookPointerId = null;
    locked = false;
    hasLockedOnce = false;
    unlockedAt = -Infinity;
    lastZoneId = null;
    lastLabel = "";
    lastBlocked = null;
    fpsSmoothed = 0;
    debugFrames = 0;
    debugLast = performance.now();
    blockedReason = null;
    blockedAt = -Infinity;
    ui.setLooking(false);
    ui.setLocked(false);
    ui.setLockPrompt(false);
    const sample = collision.sample();
    updateCamera(sample);
    updateHud(sample);
    ui.noteActivity();
  }

  // 快速移動：只換位置與面向，不改模式、不重建 BVH；HUD 會依新 zone 更新。
  function jumpTo(spawn) {
    if (!enabled || !spawn) return;
    collision.teleport(spawn.site[0], spawn.site[1], spawn.ground ?? 0);
    yaw = spawn.yaw ?? 0;
    pitch = 0;
    keys.clear();
    resetJoystick();
    dragPointerId = null;
    lookPointerId = null;
    lastZoneId = null;
    lastLabel = "";
    lastBlocked = null;
    const sample = collision.sample();
    updateCamera(sample);
    updateHud(sample);
    ui.noteActivity();
  }

  function pause() {
    enabled = false;
    keys.clear();
    resetJoystick();
    dragPointerId = null;
    lookPointerId = null;
    if (document.pointerLockElement === domElement) document.exitPointerLock?.();
    ui.setLooking(false);
    ui.setLockPrompt(false);
    ui.setDebugVisible(false);
    ui.setDebugReady(false);
  }

  function snapshot() {
    const sample = collision.sample();
    const zone = zones.zoneAt(sample.siteX, sample.siteY);
    return {
      ...sample,
      zone: zone.name_zh,
      zoneId: zone.id,
      zoneKind: zone.kind,
      label: hudLabel(zone),
      interior,
      yaw,
      pitch,
      enabled,
      locked,
      touch: ui.isTouch(),
      fps: fpsSmoothed,
      joy: { x: joyX, y: joyY, magnitude: joyMagnitude, active: joyPointerId !== null },
    };
  }

  // 驗證與 debug 用；移動仍只走鍵盤／指標事件。
  window.__walk = {
    collision,
    zones,
    snapshot,
    teleport(siteX, siteY) {
      collision.teleport(siteX, siteY);
      updateCamera(collision.sample());
      lastZoneId = null;
      updateHud(collision.sample());
      return snapshot();
    },
    look(yawDegrees, pitchDegrees = 0) {
      yaw = (yawDegrees * Math.PI) / 180;
      pitch = (pitchDegrees * Math.PI) / 180;
      updateCamera(collision.sample());
      return snapshot();
    },
    wakeHud() {
      ui.noteActivity();
    },
    getFps: () => fpsSmoothed,
    isInterior: () => interior,
    isLocked: () => locked,
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) keys.clear();
    },
  };

  return {
    enter,
    jumpTo,
    pause,
    update,
    snapshot,
    isEnabled: () => enabled,
    isInterior: () => interior,
    isLocked: () => locked,
    getFps: () => fpsSmoothed,
  };
}
