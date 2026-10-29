// nav.json 的位置名稱查詢。02 只提供最小介面；03 的 HUD 直接沿用。
// nav.json 由 scripts/write_viewer_nav.py 產生，座標為 site frame（x 東、y 北、公尺）。

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonArea(polygon) {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    area += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  }
  return Math.abs(area) / 2;
}

const FALLBACK_ZONE = { id: "campus", name_zh: "校園", kind: "outdoor" };

// 位置名稱的層級：室內補上樓層，建物與戶外沿用 zone 名稱。
// 例：「A 棟 1F · 走廊」、「A棟」、「入口廣場」。
export function zoneLabel(zone) {
  if (!zone) return FALLBACK_ZONE.name_zh;
  if (zone.kind === "interior" && String(zone.id).startsWith("a_1f_")) {
    return `A 棟 1F · ${zone.name_zh}`;
  }
  return zone.name_zh;
}

export async function loadZones(url = new URL("./nav.json", import.meta.url)) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`nav.json ${response.status}`);
  const nav = await response.json();

  // 室內優先於建物、建物優先於戶外；同層以面積小的先命中（電梯先於走廊）。
  const priority = { interior: 0, building: 1, outdoor: 2 };
  const zones = [...(nav.zones ?? [])]
    .map((zone) => ({ ...zone, area: polygonArea(zone.polygon) }))
    .sort((a, b) => {
      const byKind = (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9);
      if (byKind !== 0) return byKind;
      if (a.area !== b.area) return a.area - b.area;
      return String(a.id).localeCompare(String(b.id));
    });

  return {
    nav,
    zones,
    zoneAt(siteX, siteY) {
      for (const zone of zones) {
        if (pointInPolygon(siteX, siteY, zone.polygon)) return zone;
      }
      return FALLBACK_ZONE;
    },
  };
}
