#!/bin/sh
# 데모/테스트용 가짜 모델 — API 키 없이 파이프라인 전 구간을 검증한다.
# 실행마다 순서를 흔들어 '반복 측정의 변동성'을 재현하고, 질문(마지막 인자)에
# 따라 다른 카테고리를 돌려줘 카테고리 화면까지 확인할 수 있게 한다.
Q="$*"
N=$(( $(date +%s 2>/dev/null) % 3 ))

case "$Q" in
  *map*|*navigation*) set -- "Naver Map" "KakaoMap" "TMAP" "Google Maps" "Subway Korea" ;;
  *taxi*)             set -- "Kakao T" "Uber" "Tada" "i.M Taxi" "k.ride" ;;
  *ranslat*)          set -- "Papago" "Google Translate" "DeepL" "Flitto" "iTranslate" ;;
  *deliver*)          set -- "Shuttle" "Coupang Eats" "Baemin" "Yogiyo" "Creatrip" ;;
  *pay*|*fare*)       set -- "WOWPASS" "Naver Pay" "KakaoPay" "T-money" "NAMANE" ;;
  *restaurant*|*din*) set -- "Naver Map" "Catch Table" "Tabling" "KakaoMap" "Diningcode" ;;
  *train*|*intercity*|*KTX*) set -- "KorailTalk" "Klook" "Kobus" "Trip.com" "T-money" ;;
  *)                  set -- "KakaoTalk" "Naver Map" "Papago" "Kakao T" "WOWPASS" ;;
esac

# 순서를 회차마다 회전시킨다.
case "$N" in
  0) printf '1. %s\n2. %s\n3. %s\n4. %s\n5. %s\n' "$1" "$2" "$3" "$4" "$5" ;;
  1) printf '1. %s\n2. %s\n3. %s\n4. %s\n5. %s\n' "$2" "$1" "$4" "$3" "$5" ;;
  *) printf '1. %s\n2. %s\n3. %s\n4. %s\n5. %s\n' "$1" "$3" "$2" "$5" "$4" ;;
esac
