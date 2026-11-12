// FIRECAST 설정
// 기상청 자동 날씨: 아래 둘 중 하나만 채우면 된다.
//  1) KMA_PROXY : Cloudflare Workers 에 올린 중계 주소 (권장, 인증키가 숨겨짐)
//     예) 'https://firecast-kma.내아이디.workers.dev'
//  2) KMA_KEY   : 기상청 API허브 인증키를 직접 넣기 (기상청이 웹페이지 직접 요청을 막으면 작동하지 않음, 키가 공개됨)
window.FIRECAST_CONFIG = {
  KMA_PROXY: '',
  KMA_KEY: ''
};
