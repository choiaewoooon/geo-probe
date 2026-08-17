#!/bin/sh
# 데모/테스트용 가짜 모델 — API 키 없이 파이프라인을 검증한다.
# 실행마다 순서를 약간 흔들어 '반복 측정의 변동성'을 재현한다.
N=$(( $(date +%s%N 2>/dev/null || date +%s) % 3 ))
case "$N" in
  0) printf '1. Edelman\n2. Weber Shandwick\n3. Burson\n4. FleishmanHillard\n5. KPR\n' ;;
  1) printf '1. Edelman\n2. Burson\n3. KPR\n4. Weber Shandwick\n5. 프레인글로벌\n' ;;
  *) printf '1. KPR\n2. Edelman\n3. 프레인글로벌\n4. Weber Shandwick\n5. FleishmanHillard\n' ;;
esac
