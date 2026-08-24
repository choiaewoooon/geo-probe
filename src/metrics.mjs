// 🔒 정본은 web/public/lib/metrics.mjs 다. 이 파일은 재수출만 한다.
//
// 예전에는 src/ 가 정본이고 web/public/lib/ 이 손복사본이었는데, 복사를 자동화한
// 스크립트가 없어 조용히 갈라졌다(감사 시점 165줄 차이). 그래서 브라우저의
// "내 측정 결과" 경로가 CLI 와 다른 코드로 집계하고 있었다.
//
// 배포되는 파일이 정본이어야 이 사고가 다시 안 난다. web/public 밖의 파일은
// 정적 호스팅에서 서빙되지 않으므로 방향은 이쪽뿐이다. 둘 다 순수 ESM 이라
// 빌드 스텝 없이 그대로 import 된다.
export * from "../web/public/lib/metrics.mjs"
