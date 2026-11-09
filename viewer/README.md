# Viewer

成功國小 3D 校園的瀏覽器預覽：**鳥瞰模式**與**沉浸模式**共用一份 `../exports/ckes_v2.glb`、一次載入。

> 2026-10-25：鳥瞰與沉浸模式完成（單一 Three.js runtime）；沉浸控制器、碰撞與位置名稱見 `walk.js`、`collision.js`、`zones.js`、`nav.json`。

## 啟動

從 repo 根目錄：

```bash
make preview
# 或：uv run python scripts/preview_server.py
```

伺服器會印出 `/viewer/` 與沉浸模式的網址；預設 `127.0.0.1:8000`，可用 `--host`／`--port`（或 `HOST`／`PORT`）換。開 <http://localhost:8000/viewer/>。

## 模式

### 鳥瞰模式（預設）

從校園外部高處環繞觀看，五個視角按鈕：全校、A 棟、B 棟、操場、風雨球場。`?view=` 另有舊連結的 `gate`、`a-east`、`a-west`、`a-south`、`a-1f`，加上共用的 `all`；這六個 key 是永久介面，不能移除或改名。

### 沉浸模式

第一人稱、眼高 1.65 m 在校園走動，可走進 A 棟 1F 的川堂、B/C 中庭，也可沿汽車坡道走進 A 棟 B1F 地下停車場。A 棟目前只有平面圖外殼（牆、開口、柱、樓板與梯），沒有室內隔間與家具。

桌面：

- 點畫面鎖定滑鼠；WASD 移動、Shift 跑、空白鍵跳躍、滑鼠轉頭。
- 按滑鼠右鍵：第一人稱方塊右手從畫面上方出現、往下打、打完淡出，平時不顯示；不影響移動與碰撞。
- 未鎖定時拖曳也能轉頭；方向鍵也可轉頭。
- `Esc` 解除鎖定並顯示「點擊畫面繼續」；再按 `Esc` 或點左上「鳥瞰」回鳥瞰模式。
- 左上「鳥瞰／沉浸」兩段式切換，目前模式以 `aria-pressed` 標示，`Tab` 可達。
- 出生點：`?at=gate|hall|track|bc|b1f`；`bc` 直接站在 B/C 兩翼之間的中央中庭，面向東側；`b1f` 站在 A 棟地下停車場。
- 右上快速移動鈕：「校門」與「B/C 中庭」；沉浸模式中按一下即跳過去，BVH 還在準備時可先按，準備好會自動跳。滑鼠鎖定時 HUD 收不到點擊，改按 `G`（校門）或 `C`（B/C 中庭），或先按 `Esc` 解鎖再按。

觸控：

- 左下虛擬搖桿移動；搖桿死區 15%，死區後行程一半為步行 2.2 m/s，推到外緣為跑 5.0 m/s。
- 右側拖曳轉頭；多指同時操作時，搖桿與視角各追蹤自己的 pointerId，互不搶。
- 右下「跳」與「打」按鈕：跳躍與右鍵下打的觸控版；只有觸控裝置的沉浸模式顯示。
- 頁面停用捲動、雙擊縮放與長按選取。

HUD 與 debug：

- 左上模式鈕與位置名稱、中央 2 px 準星、底部提示；沉浸模式隱藏品牌卡、chips、頁尾與視角按鈕。
- 閒置 3 秒淡出位置與提示，只留模式鈕、校門／B/C 中庭快速移動鈕、觸控動作鈕與準星；任何移動、滑鼠、觸控或鍵盤都會讓它回來。
- `?debug=1` 在左上顯示平滑 FPS、site 座標、feet y、zone id 與 blocked 原因；按 `B` 或面板按鈕切換半透明碰撞線框。

效能（實測）：桌面 Chrome、Intel HD 630 內顯、1440×900 平均約 45 fps（44.8，未達 60）；iPad 只有 1024×768 觸控模擬，尚未實機量測。

## URL 參數

| 參數 | 值 | 說明 |
|---|---|---|
| `view` | `all` `a` `b` `track` `court`；舊連結另有 `gate` `a-east` `a-west` `a-south` `a-1f` | 鳥瞰視角；預設 `all` |
| `rotate` | `0` | 關閉鳥瞰自動旋轉，方便截圖 |
| `mode` | `walk` | 直接進入沉浸模式 |
| `at` | `gate` `hall` `track` `bc` `b1f` | 沉浸模式出生點；預設 `gate`（`bc`＝B/C 中庭、`b1f`＝A 棟地下停車場） |
| `debug` | `1` | 顯示 FPS、座標、zone、碰撞線框 |

```text
http://localhost:8000/viewer/?view=a
http://localhost:8000/viewer/?view=court
http://localhost:8000/viewer/?view=a-1f
http://localhost:8000/viewer/?view=all&rotate=0
http://localhost:8000/viewer/?mode=walk&at=gate
http://localhost:8000/viewer/?mode=walk&at=bc
http://localhost:8000/viewer/?mode=walk&at=b1f
```

`?mode=walk` 時忽略 `view`。切換模式或視角時以 `history.replaceState` 同步 URL；重新載入會回到同一模式、視角與出生點。

## 目錄

```text
viewer/
  index.html       外殼、樣式、import map
  app.js           載入 GLB、場景、模式切換
  orbit.js         鳥瞰相機與預設視角
  walk.js          第一人稱控制器與觸控
  hand.js          第一人稱方塊右手與右鍵下打動畫
  collision.js     合併網格、BVH、膠囊解算
  zones.js         nav.json 與位置名稱
  ui.js            HUD、觸控搖桿、debug
  nav.json         boundary／blockers／zones，由腳本產生；zone 可帶 z0／z1／floorY
  vendor/          three、GLTFLoader、OrbitControls、RoomEnvironment、three-mesh-bvh
```

## 契約

改動 `viewer/`、`exports/ckes_v2.glb` 或兩個 publish workflow 之後，跑：

```bash
uv run python scripts/write_viewer_nav.py       # 只在 site data 變動時
uv run python scripts/check_viewer_contract.py  # 每次改動都要過
```

檢查脚本只用 Python 標準庫，逐項印出 `PASS`／`FAIL`；任何一項失敗就 exit 1。

契約內容：

1. **相依全部本地**：vendor 目錄放 three 與 addons，頁面執行時不連外。
2. **發佈整目錄複製**：`.github/workflows/pages.yml` 與 `publish-preview.yml` 都用 `cp -R viewer/. _site/viewer/`；不新增逐檔清單。
3. **舊連結永久有效**：`?view=` 六個舊 key、`?view=a-1f`、`rotate=0` 的行為不變；按鈕改用 `a`、`b`、`track`、`court`。
4. **GLB 預算**：≤ 6 MB、≤ 600 mesh。超標先處理模型，不是放寬檢查。
   2026-11-02 由 4 MB 放寬到 6 MB，換取照片推估的立面細節；仍以合併 mesh 控制。
5. **節點命名是介面**：`BLD_`、`DET_GATE_`、`DET_A1F_`、`DET_A_FACADE_`、`DET_A_INT_`、`DET_BC_MURAL_`、`COL_`、`Trees_`、`Wall_`、`Track_`、`Road_`、`Ground_` 前綴是碰撞與材質分組的依據；改名時同步更新 `collision.js` 的排除清單與 `nav.json` 產生器。
6. **碰撞跟著模型**：碰撞由 GLB 網格產生，例外只寫在 `viewer/nav.json`；不新增手寫碰撞幾何。
7. **載入順序**：鳥瞰先可用；BVH 延後到第一次進入沉浸模式才建。

## 元件

- vendor 檔案取自 npm 套件（three 0.186.1），版本與授權在 `vendor/VERSIONS.md` 記錄；MIT，隨 repo 散布。
- 模型：`../exports/ckes_v2.glb`（glTF 2.0 binary，無 Draco／KTX2）。
- `Ground_Base` 是 420×420×0.2 m 的地板，頂面 -0.10 m；可行走外緣以 `nav.json` 的 `boundary` 為準。
  車道坡道處有開孔，坡道本身是碰撞面。
- `nav.json` 的 B1F／汽車坡道 zone 帶 `z0`、`z1` 與 `floorY`：`zoneAt` 用高度過濾，
  `collision.js` 用 `floorY` 當地下安全底，玩家才不會被地面 -0.10 m 的舊底擋住。
  沒有 `floorY` 的 zone 仍以 `Ground_Base` 為底。

## 注意

- 這是預覽，不是遊戲：沒有任務、NPC、載具、音效與存檔；第一人稱右手只是
  下打動畫，沒有攻擊或互動判定。
- A 棟 B1F、1F–5F 以平面圖外殼建置；B1F 地下停車場、A/B/C 梯（含 B1F–1F）、
  西側平台梯、戶外階梯與坡道已建（RF 圖缺 f2）。GL=0 是地面基準、不是樓層。
  1F 室內與立面窗帶仍缺。
  B/C 棟 1F–4F 以新交付的牆、開口與 C1/C2 梯重建，沒有家具。
  幼兒園 1F／RF 以平面圖外殼建置，只有牆、平台與 3 片教室屋頂；門窗、樓梯與
  教室屋頂高程待交付。
- 預覽頁已移除舊的檢視器套件；舊版網頁仍在 git 歷史。
