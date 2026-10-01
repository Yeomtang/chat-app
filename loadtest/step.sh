#!/bin/zsh
# 단계 실행: 맥미니(서버) 쪽에서 실행 → 맥스튜디오에서 부하 생성 → 서버 지표 최대값 + 운영 상태 확인
# 사용: step.sh <관객수> [워커수]
N=$1; P=${2:-8}
SP=${LT_SERVER_DIR:?테스트 서버 복사본 폴더를 LT_SERVER_DIR로 지정하세요}
KEY=$(cat $SP/.key)
START=$(($(date +%s) * 1000))
/usr/bin/ssh macstudio "cd ~/loadtest && ./node/bin/node gen.js --url http://192.168.50.192:4800 --clients $N --procs $P --ramp 20 --chatWin 5 --voteWin 10 --key $KEY" | tee $SP/result-$N.txt | grep -v '^RESULT'
END=$(($(date +%s) * 1000))
python3 - "$SP/monitor.jsonl" $START $END <<'EOF'
import json, sys
f, s, e = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rows = [json.loads(l) for l in open(f) if l.strip()]
rows = [r for r in rows if s <= r['t'] <= e]
if rows:
    print(f"⑤ 서버(맥미니): CPU 최대 {max(r['cpu'] for r in rows)}% / 메모리 최대 {max(r['rssMB'] for r in rows)}MB / 이벤트루프 지연 p99 최대 {max(r['elP99'] for r in rows)}ms, 최대 {max(r['elMax'] for r in rows)}ms")
EOF
echo "⑥ 운영: $(docker ps --format '{{.Names}}={{.Status}}' | tr '\n' ' ')"
echo "   watchdog 최근: $(tail -1 ~/deploy/automation/logs/deploy_watchdog.log | cut -c1-60)"
