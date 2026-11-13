/* FIRECAST 확산 계산 엔진 (브라우저 안에서 계산)
 * 1) 칸마다 16방향 확산 속도: Rothermel(1972) 식 + FDS Mode 1 보정 배수
 *    - 바람·경사 없는 기본 속도(R0)는 연료모델·수분별로 미리 계산한 표(model.json)에서 읽음
 * 2) 계산기: 발화 칸에서 이웃 칸까지 걸리는 시간을 더해 가며 칸마다 가장 빠른 도착 시간(분)
 * 연료 코드: 1 소나무, 2 활엽수, 4 풀, 6 논밭(GR1), 3 불에 안 타는 곳
 */
(function (root) {
  const BURN = new Set([1, 2, 4, 6]);
  // 16방향 이웃 [열 dx, 행 dy], 대각·나이트 이동 때 지나는 두 칸 [[dy,dx],[dy,dx]]
  const NB = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1],[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
  const SH = [null,null,null,null,[[0,1],[1,0]],[[0,1],[-1,0]],[[0,-1],[1,0]],[[0,-1],[-1,0]],[[1,0],[1,1]],[[0,1],[1,1]],
              [[1,0],[1,-1]],[[0,-1],[1,-1]],[[-1,0],[-1,1]],[[0,1],[-1,1]],[[-1,0],[-1,-1]],[[0,-1],[-1,-1]]];
  const ANG = NB.map(([a, b]) => Math.atan2(b, a));
  const rad = d => d * Math.PI / 180;

  function fuelMoisture(model, tempC, rh) {
    const tf = tempC * 9 / 5 + 32;
    let row = null;
    for (const [k, v] of Object.entries(model.RFM)) { const b = +k.split(',')[1]; if (tf <= b) { row = v; break; } }
    if (!row) row = model.RFM['110,999'];
    return Math.max(row[rh >= 100 ? 20 : Math.floor(Math.max(rh, 0) / 5)], 2);
  }

  function rates(model, g, windFrom, windMs, m1) {
    const n = g.ny * g.nx, out = new Float32Array(16 * n);
    const wa = rad(90 - (windFrom + 180)), ws = Math.max(windMs, 0);
    for (let p = 0; p < n; p++) {
      const f = model.fuel[g.FUEL[p]];
      if (!f) continue;
      const sl = g.SL[p], az = rad(90 - g.AZ[p]), tsl = Math.tan(rad(sl));
      const R0 = f.R0[Math.min(Math.round(m1), 30)];
      const U = ws * f.WAF * 196.85;
      const phw = f.kw * f.Cw * (U > 0 ? Math.pow(U, f.B) : 0);               // 바람 효과
      const phs = f.Cs * tsl * tsl;                                          // 경사 효과
      const vx = phw * Math.cos(wa) + phs * Math.cos(az), vy = phw * Math.sin(wa) + phs * Math.sin(az);
      const ph = Math.hypot(vx, vy), th = Math.atan2(vy, vx);               // 가장 빨리 번지는 방향
      const R = R0 * (1 + ph);                                               // 앞쪽 속도
      const Umf = ws * f.WAF, Us = Math.pow(phs / f.Cw, 1 / f.B) / 196.85;
      const ux = Umf * Math.cos(wa) + Us * Math.cos(az), uy = Umf * Math.sin(wa) + Us * Math.sin(az), Uv = Math.hypot(ux, uy);
      const LB = Math.min(Math.max(0.936 * Math.exp(0.2566 * Uv) + 0.461 * Math.exp(-0.1548 * Uv) - 0.397, 1), 8);  // 타원 길이/폭
      const sq = Math.sqrt(LB * LB - 1), HB = (LB + sq) / Math.max(LB - sq, 1e-6);
      const b = 0.5 * (R + R / HB), a = b / LB, c = b - R / HB;
      for (let k = 0; k < 16; k++) {
        const psi = ANG[k] - th, cs = Math.cos(psi), sn = Math.sin(psi);
        const A = cs * cs / (b * b) + sn * sn / (a * a), Bq = c * cs / (b * b), Cq = c * c / (b * b) - 1;
        const r = (Bq + Math.sqrt(Math.max(Bq * Bq - A * Cq, 0))) / A;
        out[k * n + p] = r * Math.cos(Math.atan(tsl * Math.cos(ANG[k] - az)));  // 경사면 -> 수평
      }
    }
    return out;
  }

  // 최소 힙
  class Heap {
    constructor() { this.t = []; this.i = []; }
    push(t, i) { const T = this.t, I = this.i; let k = T.length; T.push(t); I.push(i);
      while (k > 0) { const p = (k - 1) >> 1; if (T[p] <= T[k]) break; [T[p], T[k]] = [T[k], T[p]]; [I[p], I[k]] = [I[k], I[p]]; k = p; } }
    pop() { const T = this.t, I = this.i, t = T[0], i = I[0], lt = T.pop(), li = I.pop();
      if (T.length) { T[0] = lt; I[0] = li; let k = 0; const n = T.length;
        for (;;) { const l = 2 * k + 1, r = l + 1; let m = k;
          if (l < n && T[l] < T[m]) m = l; if (r < n && T[r] < T[m]) m = r; if (m === k) break;
          [T[m], T[k]] = [T[k], T[m]]; [I[m], I[k]] = [I[k], I[m]]; k = m; } }
      return [t, i]; }
    get size() { return this.t.length; }
  }

  function arrival(R, g, ign, tEndMin) {
    const ny = g.ny, nx = g.nx, n = ny * nx, F = g.FUEL;
    const burn = new Uint8Array(n); for (let p = 0; p < n; p++) burn[p] = BURN.has(F[p]) ? 1 : 0;
    const L = NB.map(([a, b]) => Math.hypot(a, b) * g.dx);
    const T = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
    const p0 = ign[0] * nx + ign[1]; T[p0] = 0; const h = new Heap(); h.push(0, p0);
    while (h.size) {
      const [t, p] = h.pop();
      if (done[p] || t > tEndMin) continue;
      done[p] = 1; const j = Math.floor(p / nx), i = p % nx;
      for (let k = 0; k < 16; k++) {
        const jj = j + NB[k][1], ii = i + NB[k][0];
        if (jj < 0 || jj >= ny || ii < 0 || ii >= nx) continue;
        const q = jj * nx + ii; if (!burn[q] || done[q]) continue;
        const s = SH[k];
        if (s) { const aj = j + s[0][0], ai = i + s[0][1], bj = j + s[1][0], bi = i + s[1][1];
          if (aj < 0 || aj >= ny || ai < 0 || ai >= nx || bj < 0 || bj >= ny || bi < 0 || bi >= nx) continue;
          if (!burn[aj * nx + ai] || !burn[bj * nx + bi]) continue; }
        const r1 = burn[p] ? R[k * n + p] : R[k * n + q], r2 = R[k * n + q];
        if (r1 <= 0 || r2 <= 0) continue;
        const nt = t + L[k] / 2 / r1 + L[k] / 2 / r2;
        if (nt < T[q]) { T[q] = nt; h.push(nt, q); }
      }
    }
    return T;
  }

  function decode(b64, Type) {
    const s = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const u8 = new Uint8Array(s.length); for (let k = 0; k < s.length; k++) u8[k] = s.charCodeAt(k);
    return new Type(u8.buffer);
  }
  function loadRegion(js) {
    const SL16 = decode(js.SL, Int16Array), AZ16 = decode(js.AZ, Int16Array);
    return Object.assign({}, js, { SL: Float32Array.from(SL16, v => v / 10), AZ: Float32Array.from(AZ16, v => v / 10), FUEL: decode(js.FUEL, Uint8Array) });
  }

  const api = { BURN, fuelMoisture, rates, arrival, loadRegion };
  if (typeof module !== 'undefined') module.exports = api; else root.FireEngine = api;
})(this);
