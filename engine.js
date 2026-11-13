/* FIRECAST 확산 계산 엔진 (브라우저 안에서 계산) - 강원 전체 타일 버전
 * 1) 칸마다 16방향 확산 속도: Rothermel(1972) 식 + FDS Mode 1 보정 배수
 *    - 바람·경사 없는 기본 속도(R0)는 연료모델·수분별로 미리 계산한 표(model.json)에서 읽음
 *    - 불이 닿는 칸만 그때그때 계산 (넓은 범위도 핸드폰에서 가볍게)
 * 2) 계산기: 발화 칸에서 이웃 칸까지 걸리는 시간을 더해 가며 칸마다 가장 빠른 도착 시간(분)
 * 연료 코드: 1 소나무, 2 활엽수, 4 풀, 6 논밭(GR1), 3 불에 안 타는 곳, 7 자료 없음(계산 제외), 0 바다·범위 밖
 */
(function (root) {
  const BURN = new Set([1, 2, 4, 6]);
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

  // 경사(도)·오르막 방향(도, 북=0): numpy.gradient 와 같은 방식 (가운데 차분, 가장자리는 한쪽 차분). 배열은 남쪽이 0행
  function slopeAspect(E, ny, nx, dx) {
    const SL = new Float32Array(ny * nx), AZ = new Float32Array(ny * nx);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = j * nx + i;
      const gx = i === 0 ? (E[p + 1] - E[p]) / dx : i === nx - 1 ? (E[p] - E[p - 1]) / dx : (E[p + 1] - E[p - 1]) / (2 * dx);
      const gy = j === 0 ? (E[p + nx] - E[p]) / dx : j === ny - 1 ? (E[p] - E[p - nx]) / dx : (E[p + nx] - E[p - nx]) / (2 * dx);
      SL[p] = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
      AZ[p] = (Math.atan2(gx, gy) * 180 / Math.PI + 360) % 360;
    }
    return [SL, AZ];
  }

  // 한 칸의 타원 정보 (앞쪽 속도 R, 타원 a·b·c, 가장 빨리 번지는 방향 th, 오르막 방향 az, 경사 tan)
  function cellParams(model, g, p, wa, ws, m1, out) {
    const f = model.fuel[g.FUEL[p]];
    const sl = g.SL[p], az = rad(90 - g.AZ[p]), tsl = Math.tan(rad(sl));
    const R0 = f.R0[Math.min(Math.round(m1), 30)];
    const U = ws * f.WAF * 196.85;
    const phw = f.kw * f.Cw * (U > 0 ? Math.pow(U, f.B) : 0);               // 바람 효과
    const phs = f.Cs * tsl * tsl;                                          // 경사 효과
    const vx = phw * Math.cos(wa) + phs * Math.cos(az), vy = phw * Math.sin(wa) + phs * Math.sin(az);
    const th = Math.atan2(vy, vx), R = R0 * (1 + Math.hypot(vx, vy));
    const Umf = ws * f.WAF, Us = Math.pow(phs / f.Cw, 1 / f.B) / 196.85;
    const ux = Umf * Math.cos(wa) + Us * Math.cos(az), uy = Umf * Math.sin(wa) + Us * Math.sin(az), Uv = Math.hypot(ux, uy);
    const LB = Math.min(Math.max(0.936 * Math.exp(0.2566 * Uv) + 0.461 * Math.exp(-0.1548 * Uv) - 0.397, 1), 8);
    const sq = Math.sqrt(LB * LB - 1), HB = (LB + sq) / Math.max(LB - sq, 1e-6);
    const b = 0.5 * (R + R / HB);
    out[0] = b / LB; out[1] = b; out[2] = b - R / HB; out[3] = th; out[4] = az; out[5] = tsl;
  }
  function dirRate(P, o, k) {     // P: 칸 정보 배열, o: 시작 위치, k: 방향
    const a = P[o], b = P[o + 1], c = P[o + 2], th = P[o + 3], az = P[o + 4], tsl = P[o + 5];
    const psi = ANG[k] - th, cs = Math.cos(psi), sn = Math.sin(psi);
    const A = cs * cs / (b * b) + sn * sn / (a * a), Bq = c * cs / (b * b), Cq = c * c / (b * b) - 1;
    const r = (Bq + Math.sqrt(Math.max(Bq * Bq - A * Cq, 0))) / A;
    return r * Math.cos(Math.atan(tsl * Math.cos(ANG[k] - az)));             // 경사면 -> 수평
  }

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

  /* g: {nx, ny, dx, FUEL, SL, AZ}. 반환: {T: 도착 시간(분), touchNoData, touchEdge} */
  function arrival(model, g, ign, windFrom, windMs, m1, tEndMin) {
    const ny = g.ny, nx = g.nx, n = ny * nx, F = g.FUEL;
    const wa = rad(90 - (windFrom + 180)), ws = Math.max(windMs, 0);
    const P = new Float32Array(6 * n), has = new Uint8Array(n), tmp = new Float32Array(6);
    const prm = p => { if (!has[p]) { cellParams(model, g, p, wa, ws, m1, tmp); P.set(tmp, 6 * p); has[p] = 1; } return 6 * p; };
    const L = NB.map(([a, b]) => Math.hypot(a, b) * g.dx);
    const T = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
    const burn = q => BURN.has(F[q]);
    let touchNoData = false, touchEdge = false;
    const p0 = ign[0] * nx + ign[1]; T[p0] = 0; const h = new Heap(); h.push(0, p0);
    while (h.size) {
      const [t, p] = h.pop();
      if (done[p] || t > tEndMin) continue;
      done[p] = 1; const j = Math.floor(p / nx), i = p % nx;
      if (j < 2 || j >= ny - 2 || i < 2 || i >= nx - 2) touchEdge = true;
      const op = burn(p) ? prm(p) : -1;
      for (let k = 0; k < 16; k++) {
        const jj = j + NB[k][1], ii = i + NB[k][0];
        if (jj < 0 || jj >= ny || ii < 0 || ii >= nx) continue;
        const q = jj * nx + ii;
        if (F[q] === 7 && k < 8) touchNoData = true;
        if (!burn(q) || done[q]) continue;
        const s = SH[k];
        if (s) { const aj = j + s[0][0], ai = i + s[0][1], bj = j + s[1][0], bi = i + s[1][1];
          if (aj < 0 || aj >= ny || ai < 0 || ai >= nx || bj < 0 || bj >= ny || bi < 0 || bi >= nx) continue;
          if (!burn(aj * nx + ai) || !burn(bj * nx + bi)) continue; }
        const oq = prm(q);
        const r1 = op >= 0 ? dirRate(P, op, k) : dirRate(P, oq, k), r2 = dirRate(P, oq, k);
        if (r1 <= 0 || r2 <= 0) continue;
        const nt = t + L[k] / 2 / r1 + L[k] / 2 / r2;
        if (nt < T[q]) { T[q] = nt; h.push(nt, q); }
      }
    }
    return { T, touchNoData, touchEdge };
  }

  const api = { BURN, fuelMoisture, slopeAspect, arrival };
  if (typeof module !== 'undefined') module.exports = api; else root.FireEngine = api;
})(this);
