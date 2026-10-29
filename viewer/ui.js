import { VIEWS } from "./orbit.js";

const IDLE_MS = 3000;
const ACTIVITY_THROTTLE_MS = 200;

function formatBytes(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/**
 * HUD、模式切換、準星、觸控搖桿容器與 debug 面板。
 *
 * @param {object} options
 * @param {(mode: "orbit"|"walk") => void} options.onModeSelect
 * @param {(view: string) => void} options.onViewSelect
 * @param {(spawn: string) => void} options.onSpawnSelect
 * @param {(on: boolean) => void} options.onWireframeToggle
 * @param {boolean} [options.touch] 是否為觸控裝置（顯示搖桿、換提示）
 * @param {boolean} [options.debug] ?debug=1
 */
export function createUI({ onModeSelect, onViewSelect, onSpawnSelect, onWireframeToggle, touch = false, debug = false }) {
  const stage = document.querySelector(".stage");
  const viewButtons = [...document.querySelectorAll(".viewbtn[data-view]")];
  const modeButtons = [document.getElementById("mode-orbit"), document.getElementById("mode-walk")];
  const status = document.getElementById("hud-status");
  const hint = document.getElementById("hint");
  const lockPrompt = document.getElementById("lock-prompt");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayDetail = document.getElementById("overlay-detail");
  const overlayFill = document.getElementById("overlay-fill");
  const retryButton = document.getElementById("overlay-retry");
  const debugPanel = document.getElementById("debug-panel");
  const debugFps = document.getElementById("debug-fps");
  const debugSite = document.getElementById("debug-site");
  const debugFeet = document.getElementById("debug-feet");
  const debugZone = document.getElementById("debug-zone");
  const debugBlocked = document.getElementById("debug-blocked");
  const wireButton = document.getElementById("debug-wire");
  const jumpButtons = [...document.querySelectorAll(".jumpbtn[data-spawn]")];

  let mode = "orbit";
  let currentView = "all";
  let touchMode = touch;
  let debugEnabled = debug;
  let idleTimer = 0;
  let lastActivity = 0;
  let wireOn = false;
  let lockedState = false;

  const orbitHint = "拖曳旋轉 · 滾輪縮放 · 右鍵平移";
  const walkHint = () =>
    touchMode
      ? "左搖桿移動 · 右側拖曳轉頭 · 右上可到校門或 B/C 中庭"
      : "點擊畫面鎖定滑鼠 · WASD 移動 · Shift 跑 · G 到校門 · C 到 B/C 中庭 · Esc 回鳥瞰";
  const currentWalkHint = () =>
    lockedState && !touchMode
      ? "WASD 移動 · Shift 跑 · G 到校門 · C 到 B/C 中庭 · Esc 解鎖"
      : walkHint();

  function orbitStatus() {
    return `鳥瞰 · ${VIEWS[currentView]?.label ?? "全校"}`;
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = 0;
    }
  }

  function noteActivity() {
    if (mode !== "walk") return;
    const now = performance.now();
    if (now - lastActivity < ACTIVITY_THROTTLE_MS && !stage.classList.contains("is-idle")) return;
    lastActivity = now;
    stage.classList.remove("is-idle");
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      if (mode === "walk") stage.classList.add("is-idle");
    }, IDLE_MS);
  }

  function setMode(next) {
    mode = next;
    stage.dataset.mode = next;
    for (const button of modeButtons) {
      button?.setAttribute("aria-pressed", String(button.dataset.mode === next));
    }
    stage.classList.remove("is-idle");
    stage.classList.remove("is-looking");
    lockPrompt.hidden = true;
    lockedState = false;
    clearIdleTimer();
    lastActivity = 0;

    if (next === "walk") {
      status.textContent = "沉浸 · 校園";
      hint.textContent = walkHint();
      noteActivity();
      setDebugVisible(true);
    } else {
      status.textContent = orbitStatus();
      hint.textContent = orbitHint;
      setDebugVisible(false);
    }
  }

  function setWalkPreparing() {
      status.textContent = "正在準備沉浸模式…";
    hint.textContent = "合併碰撞網格、建立 BVH…";
    clearIdleTimer();
    debugFps.textContent = "–";
    debugSite.textContent = "–";
    debugFeet.textContent = "–";
    debugZone.textContent = "–";
    debugBlocked.textContent = "–";
    setDebugReady(false);
  }

  function setWalkStatus(label) {
    for (const button of jumpButtons) button.disabled = false;
    status.textContent = `沉浸 · ${label}`;
    hint.textContent = currentWalkHint();
    setDebugReady(true);
    noteActivity();
  }

  function setActiveView(name) {
    currentView = name;
    for (const button of viewButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.view === name));
    }
    if (mode === "orbit") status.textContent = orbitStatus();
  }

  function setTouch(value) {
    touchMode = Boolean(value);
    stage.dataset.touch = touchMode ? "1" : "0";
    if (mode === "walk") hint.textContent = currentWalkHint();
  }

  function setLooking(value) {
    stage.classList.toggle("is-looking", Boolean(value));
  }

  // 滑鼠鎖定時提示改成解鎖說明；觸控沒有鎖定，維持搖桿提示。
  function setLocked(value) {
    lockedState = Boolean(value) && !touchMode;
    stage.classList.toggle("is-locked", lockedState);
    for (const button of jumpButtons) button.classList.toggle("is-key", lockedState);
    if (mode === "walk") hint.textContent = currentWalkHint();
  }

  function setLockPrompt(visible) {
    lockPrompt.hidden = !visible;
  }

  function setDebugVisible(visible) {
    debugPanel.hidden = !(debugEnabled && visible && mode === "walk");
  }

  function setDebugReady(ready) {
    wireButton.disabled = !ready;
    if (!ready) setWireframe(false);
  }

  function setDebugInfo({ fps, siteX, siteY, feetY, zoneId, blocked }) {
    debugFps.textContent = Number.isFinite(fps) ? fps.toFixed(0) : "–";
    debugSite.textContent = `${siteX.toFixed(1)}, ${siteY.toFixed(1)}`;
    debugFeet.textContent = feetY.toFixed(2);
    debugZone.textContent = zoneId ?? "–";
    debugBlocked.textContent = blocked ?? "–";
  }

  function setWireframe(on) {
    wireOn = Boolean(on);
    wireButton.setAttribute("aria-pressed", String(wireOn));
  }

  function toggleWireframe() {
    if (!debugEnabled || mode !== "walk" || wireButton.disabled) return;
    onWireframeToggle?.(!wireOn);
  }

  function setLoading(event) {
    const total = event?.total || 0;
    const loaded = event?.loaded || 0;
    overlayFill.style.width = total > 0 ? `${Math.min(100, (loaded / total) * 100)}%` : "0%";
    overlayDetail.textContent =
      total > 0
        ? `${formatBytes(loaded)} / ${formatBytes(total)}`
        : "讀取 exports/ckes_v2.glb…";
  }

  function setReady() {
    for (const button of modeButtons) button.disabled = false;
    overlay.classList.add("is-done");
    setTimeout(() => {
      overlay.hidden = true;
    }, 400);
  }

  function setError(message) {
    for (const button of modeButtons) button.disabled = true;
    overlay.hidden = false;
    overlay.classList.remove("is-done");
    overlay.classList.add("is-error");
    overlayTitle.textContent = "無法載入校園";
    overlayDetail.textContent = message;
    overlayFill.style.width = "100%";
    retryButton.hidden = false;
  }

  for (const button of modeButtons) {
    button?.addEventListener("click", () => {
      if (button.dataset.mode !== mode) onModeSelect?.(button.dataset.mode);
      noteActivity();
    });
  }
  retryButton.addEventListener("click", () => location.reload());
  for (const button of viewButtons) {
    button.addEventListener("click", () => onViewSelect(button.dataset.view));
  }
  wireButton.addEventListener("click", toggleWireframe);
  for (const button of jumpButtons) {
    button.addEventListener("click", () => {
      onSpawnSelect?.(button.dataset.spawn);
      noteActivity();
    });
  }

  // 觸控裝置禁止雙擊縮放與長按選取；canvas 的 touch-action 已由 CSS 關閉。
  document.addEventListener("gesturestart", (event) => event.preventDefault());
  document.addEventListener("dblclick", (event) => event.preventDefault(), { passive: false });

  // 任何輸入都讓淡出的 HUD 回來（walk 內才有效）。
  window.addEventListener(
    "pointermove",
    () => noteActivity(),
    { passive: true },
  );
  window.addEventListener(
    "pointerdown",
    () => noteActivity(),
    { passive: true },
  );
  window.addEventListener("keydown", () => noteActivity());
  window.addEventListener(
    "touchmove",
    (event) => {
      noteActivity();
      if (event.cancelable) event.preventDefault();
    },
    { passive: false },
  );
  window.addEventListener(
    "touchstart",
    () => {
      if (!touchMode) setTouch(true);
    },
    { passive: true, once: true },
  );

  setTouch(touchMode);
  setMode("orbit");
  setActiveView("all");
  if (debugEnabled) setDebugVisible(false);

  return {
    setMode,
    setActiveView,
    setWalkPreparing,
    setWalkStatus,
    setTouch,
    setLooking,
    setLocked,
    setLockPrompt,
    setDebugVisible,
    setDebugReady,
    setDebugInfo,
    setWireframe,
    toggleWireframe,
    noteActivity,
    setLoading,
    setReady,
    setError,
    isDebug: () => debugEnabled,
    isWireframe: () => wireOn,
    isTouch: () => touchMode,
  };
}
