// Cloudflare Workers 용 기상청 중계 코드 (인증키는 Workers 설정의 비밀 변수 KMA_KEY 에 넣는다)
// 호출: https://<워커주소>/?lat=38.089&lon=127.998  ->  {time, wind_from, wind_ms, temp_c, rh_pct, source}
function grid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, S1 = 30, S2 = 60, OLON = 126, OLAT = 38, XO = 43, YO = 136, D = Math.PI / 180;
  const re = RE / GRID, s1 = S1 * D, s2 = S2 * D, olon = OLON * D, olat = OLAT * D;
  const sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(Math.tan(Math.PI / 4 + s2 / 2) / Math.tan(Math.PI / 4 + s1 / 2));
  const sf = Math.pow(Math.tan(Math.PI / 4 + s1 / 2), sn) * Math.cos(s1) / sn, ro = re * sf / Math.pow(Math.tan(Math.PI / 4 + olat / 2), sn);
  const ra = re * sf / Math.pow(Math.tan(Math.PI / 4 + lat * D / 2), sn);
  let th = lon * D - olon; if (th > Math.PI) th -= 2 * Math.PI; if (th < -Math.PI) th += 2 * Math.PI; th *= sn;
  return [Math.floor(ra * Math.sin(th) + XO + 0.5), Math.floor(ro - ra * Math.cos(th) + YO + 0.5)];
}
export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
    try {
      const u = new URL(req.url), lat = +u.searchParams.get('lat'), lon = +u.searchParams.get('lon');
      const [nx, ny] = grid(lat, lon);
      let t = new Date(Date.now() + 9 * 3600e3); if (t.getUTCMinutes() < 45) t = new Date(t - 3600e3);
      const d = t.toISOString().slice(0, 10).replace(/-/g, ''), h = String(t.getUTCHours()).padStart(2, '0') + '00';
      const q = new URLSearchParams({ authKey: env.KMA_KEY, pageNo: 1, numOfRows: 100, dataType: 'JSON', base_date: d, base_time: h, nx, ny });
      const r = await fetch('https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getUltraSrtNcst?' + q);
      const js = await r.json(), head = js.response.header;
      if (head.resultCode !== '00') throw new Error('기상청 오류 ' + head.resultCode + ': ' + head.resultMsg);
      const v = {}; for (const it of js.response.body.items.item) v[it.category] = +it.obsrValue;
      return new Response(JSON.stringify({ time: `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)} ${h.slice(0,2)}:00`, wind_from: v.VEC, wind_ms: v.WSD,
        temp_c: v.T1H, rh_pct: v.REH, source: `기상청 초단기실황 격자(${nx},${ny})` }), { headers: cors });
    } catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: cors }); }
  }
};
