// 서버 계측 — 앱 코드를 고치지 않고 `node -r ./monitor.js server.js` 로 함께 불러온다.
// 1초마다 CPU·메모리·이벤트 루프 지연을 MONITOR_OUT 파일에 JSON 한 줄씩 기록한다.
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');

const out = process.env.MONITOR_OUT || 'monitor.jsonl';
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
let lastCpu = process.cpuUsage();
let lastT = process.hrtime.bigint();

setInterval(() => {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const elapsedUs = Number(now - lastT) / 1000;
  const usedUs = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system);
  lastCpu = cpu; lastT = now;
  const m = process.memoryUsage();
  const line = {
    t: Date.now(),
    cpu: Math.round((usedUs / elapsedUs) * 1000) / 10, // % of one core
    rssMB: Math.round(m.rss / 1048576),
    heapMB: Math.round(m.heapUsed / 1048576),
    elP50: Math.round(h.percentile(50) / 1e6),
    elP99: Math.round(h.percentile(99) / 1e6),
    elMax: Math.round(h.max / 1e6),
  };
  h.reset();
  fs.appendFile(out, JSON.stringify(line) + '\n', () => {});
}, 1000).unref();
