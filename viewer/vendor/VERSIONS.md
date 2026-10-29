# Vendor 版本

全部檔案取自 npm 套件，執行時不連外。

| 套件 | 版本 | 來源 | 授權 |
|---|---|---|---|
| three | 0.186.1 | npm `three@0.186.1`（`npm pack three@0.186.1`） | MIT，見 `THREE-LICENSE.txt` |
| three-mesh-bvh | 0.9.16 | npm `three-mesh-bvh@0.9.16`（`npm pack three-mesh-bvh@0.9.16`） | MIT，見 `THREE-MESH-BVH-LICENSE.txt` |

## 檔案對照

| 本地路徑 | 套件內路徑 |
|---|---|
| `three.module.js` | `build/three.module.js` |
| `three.core.js` | `build/three.core.js`（three.module.js 的相對匯入） |
| `addons/loaders/GLTFLoader.js` | `examples/jsm/loaders/GLTFLoader.js` |
| `addons/utils/BufferGeometryUtils.js` | `examples/jsm/utils/BufferGeometryUtils.js` |
| `addons/utils/SkeletonUtils.js` | `examples/jsm/utils/SkeletonUtils.js` |
| `addons/controls/OrbitControls.js` | `examples/jsm/controls/OrbitControls.js` |
| `addons/environments/RoomEnvironment.js` | `examples/jsm/environments/RoomEnvironment.js` |
| `addons/three-mesh-bvh/index.module.js` | `build/index.module.js` |
| `THREE-LICENSE.txt` | `LICENSE` |
| `THREE-MESH-BVH-LICENSE.txt` | three-mesh-bvh 的 `LICENSE` |

`addons/` 保留 `examples/jsm/` 的相對目錄結構，所以 addon 之間的相對匯入不必改寫。
`GLTFLoader` 會間接匯入 `BufferGeometryUtils` 與 `SkeletonUtils`，兩者一併放入。
`three.module.js` 會相對匯入 `three.core.js`，所以兩個 build 檔都要放。

> `addons/environments/RoomEnvironment.js` 的上游註解原本提到舊檢視器專案的 EnvironmentScene；
> 為保持相依檢查乾淨，已刪除該兩行註解，程式行為與授權不變。
> `addons/three-mesh-bvh/index.module.js` 已移除 `sourceMappingURL` 註解（未散布 source map）；
> 程式行為與授權不變。
