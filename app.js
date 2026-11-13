/* FIRECAST 화면 동작 - 강원 전체 (서버 없이 브라우저 안에서 계산)
 * 지형·연료는 15 km 조각(tiles/t_가로_세로.png)으로 나뉘어 있고, 불 난 곳 주변 30 km 만 불러와 계산한다.
 * 조각 그림 한 점 = 30 m 칸: 빨강·초록 = 높이(m)x10+1000 (16비트), 파랑 = 연료 코드
 */
const $ = id => document.getElementById(id);
const CFG = window.FIRECAST_CONFIG || {};
proj4.defs('EPSG:5179', '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
const toTM = (lat, lon) => proj4('EPSG:4326', 'EPSG:5179', [lon, lat]);
const toLL = (x, y) => { const [lon, lat] = proj4('EPSG:5179', 'EPSG:4326', [x, y]); return [lat, lon]; };

const WIN = 1000;                     // 계산 범위: 1000 x 1000 칸 = 30 km (불 주변 15 km)
const EXAMPLES = {
  nangok: { label: '2023-04-11 08시 강릉 난곡동 산불 당시 (북강릉 기준 근사)', fire: [37.7949556509353, 128.882281608466], wind_from: 250, wind_ms: 12, temp_c: 12, rh_pct: 25, start: '08:22' },
  yanggu: { label: '2022-04-10 15시 양구 송청리 산불 당시 (양구 AWS)', fire: [38.0890463737903, 127.998472973324], wind_from: 165, wind_ms: 5.9, temp_c: 26.3, rh_pct: 13, start: '15:40' },
};
let MODEL = null, IDX = null, HAVE = new Set(), mode = 'fire', fire = null, home = null, overlay = null, frame = null;
const TILE = new Map();               // 불러온 조각 저장

// ---------- 지도 ----------
const map = L.map('map').setView([37.75, 128.3], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
const icon = h => L.divIcon({ html: h, className: '', iconSize: [24, 24], iconAnchor: [12, 12] });
const fireM = L.marker([0, 0], { icon: icon('🔥') }), homeM = L.marker([0, 0], { icon: icon('🏠') });
const lg = L.control({ position: 'bottomright' });
lg.onAdd = () => { const d = L.DomUtil.create('div', 'legend');
  d.innerHTML = '<b>불이 도착하는 시간</b><br>' + [['#7A0D0D','1시간 안'],['#C4301F','1~2시간'],['#EE6A2C','2~3시간'],['#F5A03A','3~4시간'],['#F7DD72','4~6시간'],['#9678C8','6시간 이후 (검증 밖)'],['#8A8A8A','연료 자료 없음 (계산 제외)']]
    .map(([c, t]) => `<i style="background:${c}"></i>${t}`).join('<br>'); return d; };
lg.addTo(map);

const getJSON = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' 읽기 실패'); return r.json(); });
Promise.all([getJSON('data/model.json'), getJSON('tiles/index.json')]).then(([m, idx]) => {
  MODEL = m; IDX = idx; HAVE = new Set(idx.tiles.map(([i, j]) => `${i}_${j}`));
}).catch(e => { $('result').innerHTML = `<div class="warn">자료를 읽지 못했습니다: ${e.message}</div>`; });

function setMode(m) { mode = m; $('bFire').classList.toggle('on', m === 'fire'); $('bHome').classList.toggle('on', m === 'home'); }
$('bFire').onclick = () => setMode('fire'); $('bHome').onclick = () => setMode('home');
function setFire(p) { fire = p; fireM.setLatLng(p).addTo(map); setMode('home'); showPos(); $('wsrc').textContent = '불 위치가 바뀌었습니다. 날씨를 다시 받거나 입력하세요.'; }
map.on('click', e => {
  const p = [e.latlng.lat, e.latlng.lng];
  if (mode === 'fire') setFire(p); else { home = p; homeM.setLatLng(p).addTo(map); showPos(); }
});
function showPos() {
  $('pos').textContent = (fire ? `불: ${fire[0].toFixed(4)}, ${fire[1].toFixed(4)}` : '불 난 곳을 찍으세요') + ' / ' +
                         (home ? `집: ${home[0].toFixed(4)}, ${home[1].toFixed(4)}` : '우리 집을 찍으세요');
}
$('bGps').onclick = () => {
  if (!navigator.geolocation) return alert('이 브라우저는 위치 기능을 지원하지 않습니다.');
  $('pos').textContent = '위치 찾는 중...';
  navigator.geolocation.getCurrentPosition(p => { home = [p.coords.latitude, p.coords.longitude]; homeM.setLatLng(home).addTo(map); map.panTo(home); showPos(); },
    err => { showPos(); alert('위치를 가져오지 못했습니다: ' + err.message + '\n(https 주소에서만 작동하고, 위치 권한을 허용해야 합니다)'); },
    { enableHighAccuracy: true, timeout: 15000 });
};

// ---------- 날씨 ----------
function setW(w, src) { $('wd').value = w.wind_from; $('ws').value = w.wind_ms; $('ta').value = w.temp_c; $('rh').value = w.rh_pct; $('wsrc').textContent = src; }
function kmaGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, D = Math.PI / 180, re = RE / GRID, s1 = 30 * D, s2 = 60 * D, olon = 126 * D, olat = 38 * D;
  const sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(Math.tan(Math.PI / 4 + s2 / 2) / Math.tan(Math.PI / 4 + s1 / 2));
  const sf = Math.pow(Math.tan(Math.PI / 4 + s1 / 2), sn) * Math.cos(s1) / sn, ro = re * sf / Math.pow(Math.tan(Math.PI / 4 + olat / 2), sn);
  const ra = re * sf / Math.pow(Math.tan(Math.PI / 4 + lat * D / 2), sn);
  let th = lon * D - olon; if (th > Math.PI) th -= 2 * Math.PI; if (th < -Math.PI) th += 2 * Math.PI; th *= sn;
  return [Math.floor(ra * Math.sin(th) + 43 + 0.5), Math.floor(ro - ra * Math.cos(th) + 136 + 0.5)];
}
async function kmaDirect(lat, lon) {
  const [nx, ny] = kmaGrid(lat, lon); let t = new Date(Date.now() + 9 * 3600e3); if (t.getUTCMinutes() < 45) t = new Date(t - 3600e3);
  const d = t.toISOString().slice(0, 10).replace(/-/g, ''), h = String(t.getUTCHours()).padStart(2, '0') + '00';
  const q = new URLSearchParams({ authKey: CFG.KMA_KEY, pageNo: 1, numOfRows: 100, dataType: 'JSON', base_date: d, base_time: h, nx, ny });
  const js = await (await fetch('https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getUltraSrtNcst?' + q)).json();
  if (js.response.header.resultCode !== '00') throw new Error(js.response.header.resultMsg);
  const v = {}; for (const it of js.response.body.items.item) v[it.category] = +it.obsrValue;
  return { time: `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)} ${h.slice(0,2)}:00`, wind_from: v.VEC, wind_ms: v.WSD, temp_c: v.T1H, rh_pct: v.REH, source: `기상청 초단기실황 격자(${nx},${ny})` };
}
$('bKma').onclick = async () => {
  if (!fire) { $('wsrc').textContent = '먼저 지도에서 불 난 곳을 찍으세요. 그 자리의 날씨를 받아 옵니다.'; return; }
  if (!CFG.KMA_PROXY && !CFG.KMA_KEY) { $('wsrc').textContent = '기상청 자동을 쓰려면 config.js 에 중계 주소(KMA_PROXY)를 넣어야 합니다.'; return; }
  $('wsrc').textContent = '기상청에서 받는 중...';
  try {
    const w = CFG.KMA_PROXY ? await (await fetch(`${CFG.KMA_PROXY}?lat=${fire[0]}&lon=${fire[1]}`)).json() : await kmaDirect(fire[0], fire[1]);
    if (w.error) throw new Error(w.error);
    setW(w, `🔥 불 난 곳 날씨 · ${w.source} · ${w.time} 관측`); $('start').value = new Date().toTimeString().slice(0, 5);
  } catch (e) { $('wsrc').textContent = '기상청 자료를 받지 못했습니다: ' + e.message; }
};
$('example').onchange = () => {
  const ex = EXAMPLES[$('example').value]; if (!ex) return;
  setFire(ex.fire); setW(ex, ex.label); $('start').value = ex.start; map.setView(ex.fire, 12);
};
$('start').value = new Date().toTimeString().slice(0, 5);

// ---------- 지형·연료 조각 불러오기 ----------
function loadTile(ti, tj) {
  const key = `${ti}_${tj}`;
  if (!HAVE.has(key)) return Promise.resolve(null);
  if (TILE.has(key)) return TILE.get(key);
  const pr = new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0); ok(x.getImageData(0, 0, img.width, img.height).data);
    };
    img.onerror = () => bad(new Error(`조각 t_${key} 읽기 실패`));
    img.src = `tiles/t_${String(ti).padStart(2, '0')}_${String(tj).padStart(2, '0')}.png`;
  });
  TILE.set(key, pr); return pr;
}
// 불 주변 WIN x WIN 칸 조립 (배열은 남쪽이 0행)
async function buildWindow(cj, ci) {
  const T = IDX.tile, Hn = IDX.ny * T, Wn = IDX.nx * T;
  const j0 = Math.max(0, Math.min(cj - WIN / 2, Hn - WIN)), i0 = Math.max(0, Math.min(ci - WIN / 2, Wn - WIN));
  const ny = Math.min(WIN, Hn), nx = Math.min(WIN, Wn), n = ny * nx;
  const E = new Float32Array(n), FUEL = new Uint8Array(n);
  for (let tj = Math.floor(j0 / T); tj <= Math.floor((j0 + ny - 1) / T); tj++)
    for (let ti = Math.floor(i0 / T); ti <= Math.floor((i0 + nx - 1) / T); ti++) {
      const d = await loadTile(ti, tj); if (!d) continue;
      for (let r = 0; r < T; r++) {                       // r: 그림의 행(위=북). 남쪽 기준 행 = T-1-r
        const gj = tj * T + (T - 1 - r) - j0; if (gj < 0 || gj >= ny) continue;
        for (let c = 0; c < T; c++) {
          const gi = ti * T + c - i0; if (gi < 0 || gi >= nx) continue;
          const o = 4 * (r * T + c), p = gj * nx + gi;
          E[p] = (d[o] * 256 + d[o + 1]) / 10 - 100; FUEL[p] = d[o + 2];
        }
      }
    }
  const [SL, AZ] = FireEngine.slopeAspect(E, ny, nx, IDX.dx);
  return { ny, nx, dx: IDX.dx, j0, i0, x0: IDX.x0 + i0 * IDX.dx, y0: IDX.y0 + j0 * IDX.dx, E, FUEL, SL, AZ };
}
function globalCell(lat, lon) {
  const [x, y] = toTM(lat, lon); return [Math.floor((y - IDX.y0) / IDX.dx), Math.floor((x - IDX.x0) / IDX.dx)];
}

// ---------- 계산 ----------
const fmt = m => { const h = Math.floor(Math.round(m) / 60), mm = Math.round(m) % 60; return h ? `${h}시간 ${mm}분` : `${mm}분`; };
$('bRun').onclick = () => {
  if (!MODEL || !IDX) return;
  if (!fire) return alert('먼저 지도에서 불 난 곳을 찍으세요.');
  $('result').innerHTML = '<div class="info">지형·연료 불러오는 중...</div>';
  setTimeout(() => run().catch(e => $('result').innerHTML = `<div class="warn">${e.message}</div>`), 30);
};
async function run() {
  const hours = Math.min(Math.max(+$('hours').value || 6, 1), 12);
  const w = { wind_from: +$('wd').value, wind_ms: +$('ws').value, temp_c: +$('ta').value, rh_pct: +$('rh').value };
  const [cj, ci] = globalCell(...fire);
  if (cj < 0 || ci < 0 || cj >= IDX.ny * IDX.tile || ci >= IDX.nx * IDX.tile) return $('result').innerHTML = '<div class="warn">강원 자료 범위 밖입니다.</div>';
  const g = await buildWindow(cj, ci);
  let ign = [cj - g.j0, ci - g.i0];
  const fc = g.FUEL[ign[0] * g.nx + ign[1]];
  if (fc === 7) return $('result').innerHTML = '<div class="warn">이곳은 연료 자료가 없는 지역(접경지역 등)이라 계산할 수 없습니다.</div>';
  if (fc === 0) return $('result').innerHTML = '<div class="warn">바다이거나 자료 범위 밖입니다.</div>';
  if (!FireEngine.BURN.has(fc)) {                       // 건물·도로·물이면 90 m 안 가장 가까운 숲·풀밭에서 시작
    let best = null;
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
      const j = ign[0] + dj, i = ign[1] + di;
      if (j >= 0 && j < g.ny && i >= 0 && i < g.nx && FireEngine.BURN.has(g.FUEL[j * g.nx + i]) && (!best || dj * dj + di * di < best[0])) best = [dj * dj + di * di, [j, i]];
    }
    if (!best) return $('result').innerHTML = '<div class="warn">발화점 주변 90 m 안에 탈 것(숲·풀밭·논밭)이 없습니다. 다른 곳을 눌러 주세요.</div>';
    ign = best[1];
  }
  $('result').innerHTML = '<div class="info">계산 중...</div>'; await new Promise(r => setTimeout(r, 20));
  const m1 = FireEngine.fuelMoisture(MODEL, w.temp_c, w.rh_pct);
  const res = FireEngine.arrival(MODEL, g, ign, w.wind_from, w.wind_ms, m1, hours * 60), T = res.T;

  // 지도 그림: 계산 범위를 위경도 픽셀로 다시 그림
  const cs = [toLL(g.x0, g.y0), toLL(g.x0 + g.nx * g.dx, g.y0), toLL(g.x0, g.y0 + g.ny * g.dx), toLL(g.x0 + g.nx * g.dx, g.y0 + g.ny * g.dx)];
  const s = Math.min(...cs.map(v => v[0])), n = Math.max(...cs.map(v => v[0])), wl = Math.min(...cs.map(v => v[1])), e = Math.max(...cs.map(v => v[1]));
  const H = 700, W = Math.round(H * (e - wl) * Math.cos((s + n) / 2 * Math.PI / 180) / (n - s));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
  const BR = [0, 60, 120, 180, 240, 360, 720], COL = [[122,13,13],[196,48,31],[238,106,44],[245,160,58],[247,221,114],[150,120,200]];
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const lat = n - (py + 0.5) / H * (n - s), lon = wl + (px + 0.5) / W * (e - wl);
    const [x, y] = toTM(lat, lon), i = Math.floor((x - g.x0) / g.dx), j = Math.floor((y - g.y0) / g.dx);
    if (j < 0 || j >= g.ny || i < 0 || i >= g.nx) continue;
    const p = j * g.nx + i, o = 4 * (py * W + px), t = T[p];
    if (t <= hours * 60) {
      let k = 0; while (k < 5 && t > BR[k + 1]) k++;
      img.data[o] = COL[k][0]; img.data[o + 1] = COL[k][1]; img.data[o + 2] = COL[k][2]; img.data[o + 3] = 190;
    } else if (g.FUEL[p] === 7 && ((px >> 2) + (py >> 2)) % 2 === 0) {      // 자료 없음: 회색 격자무늬
      img.data[o] = 138; img.data[o + 1] = 138; img.data[o + 2] = 138; img.data[o + 3] = 110;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (overlay) map.removeLayer(overlay); if (frame) map.removeLayer(frame);
  overlay = L.imageOverlay(cv.toDataURL(), [[s, wl], [n, e]], { opacity: 0.85 }).addTo(map);
  frame = L.polygon([cs[0], cs[1], cs[3], cs[2]], { color: '#555', weight: 1, fill: false, dashArray: '4' }).addTo(map);

  // 결과 글
  const warn = ['진화 작업과 비화(불씨 날림)는 계산에 들어가지 않았습니다.'];
  let h = '';
  if (home) {
    const [hj, hi] = globalCell(...home), lj = hj - g.j0, li = hi - g.i0;
    if (lj < 0 || lj >= g.ny || li < 0 || li >= g.nx) h += '<div class="big" style="font-size:15px">우리 집이 계산 범위(불 주변 약 15 km) 밖입니다.</div>';
    else {
      let t = Infinity;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const j = lj + dj, i = li + di; if (j >= 0 && j < g.ny && i >= 0 && i < g.nx) t = Math.min(t, T[j * g.nx + i]);
      }
      if (isFinite(t)) {
        h += `<div class="big">우리 집 주변(60 m)까지 약 ${fmt(t / 1.5)} ~ ${fmt(t * 1.5)}</div><div class="info">계산값 ${fmt(t)}, 오차 범위 ±50%</div>`;
        if (t * 1.5 <= 120) warn.unshift('2시간 안에 도달할 수 있습니다. 대피를 준비하세요.');
      } else h += `<div class="big" style="font-size:15px">${hours}시간 안에는 우리 집까지 오지 않는 것으로 계산됩니다.</div>`;
    }
  } else h += '<div class="info">우리 집을 찍으면 도착 시간을 알려 드립니다.</div>';
  const areas = []; for (let k = 1; k <= hours; k++) { let c = 0; for (const t of T) if (t <= k * 60) c++; areas.push(`${k}시간 ${(c * g.dx * g.dx / 1e4).toFixed(1)} ha`); }
  h += `<div class="info">탄 면적: ${areas.join(' · ')}<br>연료 수분 ${m1}%</div>`;
  if (res.touchNoData) warn.push('불이 연료 자료가 없는 지역(회색 무늬)에 닿았습니다. 그쪽으로는 계산하지 않았으므로 실제로는 더 번질 수 있습니다.');
  if (res.touchEdge) warn.push('불이 계산 범위(점선, 불 주변 약 15 km) 끝에 닿았습니다. 그 밖은 계산하지 않았습니다.');
  if (hours > 6) warn.push('6시간 이후는 검증하지 않은 범위입니다 (보라색 부분).');
  const [sh, sm] = ($('start').value || '12:00').split(':').map(Number);
  for (let k = 0; k <= hours * 6; k++) { const hh = Math.floor((sh * 60 + sm + 10 * k) / 60) % 24; if (hh >= 19 || hh < 6) { warn.push('밤 시간이 포함됩니다. 밤사이 확산은 검증되지 않았습니다.'); break; } }
  if (w.wind_ms >= 7) warn.push('강풍입니다. 비화 때문에 실제로는 더 빨리, 더 멀리 번질 수 있습니다.');
  h += warn.map(x => `<div class="warn">⚠ ${x}</div>`).join('');
  $('result').innerHTML = h;
}

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
