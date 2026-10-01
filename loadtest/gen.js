// 부하 생성기 (부하 PC에서 실행) — 관객 폰과 같은 순서로 접속해 채팅·투표를 보내고,
// LED 역할의 관찰자 클라이언트로 도착 지연·누락을 잰다.
//
// 사용: node gen.js --url http://192.168.50.192:4800 --clients 500 --procs 8 --key 관리자키
// 단계: ① 접속(ramp초에 걸쳐 분산) ② 채팅 버스트(1인 1건, chatWin초 안 무작위 시각)
//       ③ 투표(관리자가 시작 → 각자 voteWin초 안 무작위 시각에 투표, 30%는 한 번 변경) ④ 채팅 복귀
// open model: 보낼 시각을 미리 정해 두고 응답과 무관하게 보낸다(서버가 느려도 부하가 줄지 않음).
const { fork } = require('child_process');
const os = require('os');
const { io } = require('socket.io-client');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i + 1];
}
const URL = arg('url', 'http://localhost:4800');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const summary = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: arr.length ? Math.max(...arr) : null });

// ───────────────────────── 워커: 관객 소켓 N개 ─────────────────────────
if (process.env.LT_WORKER) {
  const wid = Number(process.env.LT_WORKER_ID);
  const sockets = [];
  const modeRecv = []; // 투표 시작 신호 도착 시각
  const disconnectReasons = {}; let closing = false; const T0 = Date.now();
  let lastCpu = process.cpuUsage(), lastT = Date.now(), cpuMax = 0;
  setInterval(() => {
    const c = process.cpuUsage(), t = Date.now();
    const pctCpu = ((c.user - lastCpu.user + c.system - lastCpu.system) / 1000) / (t - lastT) * 100;
    lastCpu = c; lastT = t;
    if (pctCpu > cpuMax) cpuMax = pctCpu;
  }, 1000).unref();

  process.on('message', async (msg) => {
    if (msg.cmd === 'connect') {
      const { count, ramp, base } = msg;
      const connectMs = [];
      let errors = 0, done = 0;
      await new Promise((resolve) => {
        for (let i = 0; i < count; i++) {
          const delay = Math.random() * ramp * 1000;
          setTimeout(() => {
            const cid = `lt-${wid}-${base + i}-${Math.random().toString(36).slice(2, 8)}`;
            const t0 = Date.now();
            // 실제 폰과 같은 기본 transport(polling → websocket 업그레이드)
            const s = io(URL, { forceNew: true, reconnectionDelayMax: 10000, auth: { clientId: cid } });
            s.cid = cid;
            s.reconnects = 0;
            s.io.on('reconnect', () => s.reconnects++);
            s.on('disconnect', (reason) => {
              if (closing) return;
              const key = `${reason}@${s.lastTransport || '?'}@${Math.round((Date.now() - T0) / 1000)}s`;
              disconnectReasons[key] = (disconnectReasons[key] || 0) + 1;
            });
            s.io.on('open', () => { s.lastTransport = s.io.engine.transport.name; s.io.engine.on('upgrade', (t) => { s.lastTransport = t.name; }); });
            s.on('connect', () => {
              if (!s.firstConnect) {
                s.firstConnect = true;
                connectMs.push(Date.now() - t0);
                done++; if (done + errors === count) resolve();
              }
              s.emit('identify', cid);
              s.emit('claimNickname', { name: `부하 ${base + i}`, theme: 'office' });
            });
            s.on('connect_error', () => {
              if (!s.firstConnect && !s.countedErr) { s.countedErr = true; errors++; if (done + errors === count) resolve(); }
            });
            s.on('modeChange', (st) => {
              if (st.mode === 'voting' && !s.voteScheduled) {
                s.voteScheduled = true;
                modeRecv.push(Date.now());
                const opts = st.voteOptions.length;
                const at = Math.random() * msg.voteWin * 1000;
                setTimeout(() => {
                  s.emit('vote', { choice: Math.floor(Math.random() * opts) });
                  process.send({ cmd: 'voteSent', t: Date.now() });
                  if (Math.random() < 0.3) {
                    setTimeout(() => {
                      s.emit('vote', { choice: Math.floor(Math.random() * opts) });
                      process.send({ cmd: 'voteSent', t: Date.now(), change: true });
                    }, 1000 + Math.random() * 3000);
                  }
                }, at);
              }
              if (st.mode === 'chat') s.voteScheduled = false;
            });
            sockets.push(s);
          }, delay);
        }
        setTimeout(resolve, (ramp + 60) * 1000); // 안전장치
      });
      process.send({ cmd: 'connected', connectMs, errors });
    }
    if (msg.cmd === 'chat') {
      // 1인 1건, chatWin초 안 무작위 시각 (메시지에 송신 시각·순번 포함)
      for (const s of sockets) {
        const at = Math.random() * msg.chatWin * 1000;
        setTimeout(() => {
          if (!s.connected) return;
          const seq = `${s.cid}`;
          s.emit('chat', { nickname: '부하', text: `LT|${seq}|${Date.now()}` });
          process.send({ cmd: 'chatSent' });
        }, at);
      }
    }
    if (msg.cmd === 'report') {
      process.send({
        cmd: 'report', modeRecv, cpuMax: Math.round(cpuMax),
        connected: sockets.filter(s => s.connected).length,
        reconnects: sockets.reduce((a, s) => a + s.reconnects, 0),
        disconnectReasons,
        transports: sockets.reduce((a, s) => { const t = s.connected ? s.io.engine.transport.name : 'down'; a[t] = (a[t] || 0) + 1; return a; }, {}),
      });
    }
    if (msg.cmd === 'close') {
      closing = true;
      sockets.forEach(s => s.close());
      setTimeout(() => process.exit(0), 300);
    }
  });
  return;
}

// ───────────────────────── 메인: 조정 + 관찰자 + 관리자 ─────────────────────────
(async () => {
  const N = Number(arg('clients', 200));
  const P = Number(arg('procs', Math.min(8, os.cpus().length)));
  const ramp = Number(arg('ramp', 20));
  const chatWin = Number(arg('chatWin', 5));
  const voteWin = Number(arg('voteWin', 10));
  const KEY = arg('key', '');
  console.log(`▶ ${URL} 관객 ${N}명, 워커 ${P}개, 접속 ${ramp}초 분산`);

  // 관찰자(LED 역할): identify만 하고 수신 시각 기록
  const obs = io(URL, { forceNew: true });
  const chatLat = []; const seen = new Set();
  const voteTimeline = []; // [recvTime, total]
  let modeVotingAt = null;
  obs.on('connect', () => { obs.emit('identify', 'lt-observer-led'); obs.emit('registerScreen'); });
  const onChat = (m) => {
    const p = typeof m.text === 'string' && m.text.split('|');
    if (p && p[0] === 'LT') { chatLat.push(Date.now() - Number(p[2])); seen.add(p[1]); }
  };
  obs.on('chat', onChat);
  obs.on('chatBatch', (list) => list.forEach(onChat)); // 서버가 묶어 보낸 채팅
  obs.on('voteUpdate', (d) => voteTimeline.push([Date.now(), d.counts.total]));
  obs.on('modeChange', (st) => { if (st.mode === 'voting' && !modeVotingAt) modeVotingAt = Date.now(); });

  // 관리자
  const admin = io(URL, { forceNew: true, auth: { key: KEY } });
  let authErr = false; admin.on('authError', () => { authErr = true; });
  await new Promise(r => admin.on('connect', r));

  // 워커 기동
  const workers = [];
  const per = Math.ceil(N / P);
  let chatSent = 0, voteChanges = 0; const voteSends = []; // 첫 투표 전송 시각만 (변경은 집계 인원을 늘리지 않음)
  const pending = new Map();
  for (let w = 0; w < P; w++) {
    const child = fork(__filename, process.argv.slice(2), { env: { ...process.env, LT_WORKER: '1', LT_WORKER_ID: String(w) } });
    child.on('message', (m) => {
      if (m.cmd === 'chatSent') chatSent++;
      else if (m.cmd === 'voteSent') { if (m.change) voteChanges++; else voteSends.push(m.t); }
      else if (pending.has(w + m.cmd)) { pending.get(w + m.cmd)(m); pending.delete(w + m.cmd); }
    });
    workers.push(child);
  }
  const ask = (cmd, extra = {}) => Promise.all(workers.map((c, w) => new Promise(r => {
    pending.set(w + (cmd === 'connect' ? 'connected' : cmd), r);
    c.send({ cmd, ...extra, base: w * per, count: Math.min(per, N - w * per) });
  })));

  // ① 접속
  const t0 = Date.now();
  const conn = await ask('connect', { ramp, voteWin });
  const connectMs = conn.flatMap(r => r.connectMs);
  const connErr = conn.reduce((a, r) => a + r.errors, 0);
  console.log(`① 접속: ${connectMs.length}/${N} 성공, 실패 ${connErr}, 전체 소요 ${((Date.now() - t0) / 1000).toFixed(1)}초, 접속시간`, summary(connectMs));
  await sleep(3000);

  // ② 채팅 버스트
  workers.forEach(c => c.send({ cmd: 'chat', chatWin }));
  await sleep((chatWin + 15) * 1000);
  console.log(`② 채팅: 보냄 ${chatSent}, LED 도착 ${seen.size} (누락 ${chatSent - seen.size}), 지연ms`, summary(chatLat));

  // ③ 투표
  const voteStartEmit = Date.now();
  admin.emit('admin:startVoting', { question: '부하 테스트 투표', type: 'choice', options: ['A', 'B', 'C', 'D'], duration: voteWin + 20 });
  await sleep((voteWin + 25) * 1000);
  const rep = await Promise.all(workers.map((c, w) => new Promise(r => { pending.set(w + 'report', r); c.send({ cmd: 'report' }); })));
  const modeRecv = rep.flatMap(r => r.modeRecv).map(t => t - voteStartEmit);
  // k번째로 보낸 표가 LED 집계에 반영되기까지 (보낸 순서 k ↔ 집계 total이 k에 처음 도달한 시각, 첫 투표만)
  const firstVotes = voteSends.length;
  const sendsSorted = [...voteSends].sort((a, b) => a - b);
  const voteLat = [];
  let vi = 0;
  for (const [t, total] of voteTimeline) {
    while (vi < total && vi < sendsSorted.length) { voteLat.push(t - sendsSorted[vi]); vi++; }
  }
  const finalTotal = voteTimeline.length ? voteTimeline[voteTimeline.length - 1][1] : 0;
  console.log(`③ 투표: 시작 신호 관찰자(LED) ${modeVotingAt ? modeVotingAt - voteStartEmit : '미도착'}ms, 관객 도착 ${modeRecv.length}/${N}`, summary(modeRecv));
  console.log(`   첫 투표 ${firstVotes} + 변경 ${voteChanges}, LED 최종 집계 ${finalTotal}명, 집계 반영 지연ms(근사)`, summary(voteLat));
  admin.emit('admin:returnToChat');

  const cpuMax = Math.max(...rep.map(r => r.cpuMax));
  console.log('   전송 방식 분포', JSON.stringify(rep.reduce((a, r) => { for (const [k, v] of Object.entries(r.transports)) a[k] = (a[k] || 0) + v; return a; }, {})));
  console.log(`④ 부하 PC 워커 CPU 최대 ${cpuMax}% (한 코어 기준, 70% 넘으면 결과 무효)  재연결 ${rep.reduce((a, r) => a + r.reconnects, 0)}회 (끊긴 이유 ${JSON.stringify(rep.reduce((a, r) => { for (const [k, v] of Object.entries(r.disconnectReasons)) a[k] = (a[k] || 0) + v; return a; }, {}))})  관리자 인증오류 ${authErr}`);

  const result = { url: URL, N, P, connect: { ok: connectMs.length, err: connErr, ms: summary(connectMs) },
    chat: { sent: chatSent, arrived: seen.size, ms: summary(chatLat) },
    vote: { signalLed: modeVotingAt ? modeVotingAt - voteStartEmit : null, signalAudience: summary(modeRecv), sent: firstVotes, finalTotal, ms: summary(voteLat) },
    genCpuMax: cpuMax };
  console.log('RESULT ' + JSON.stringify(result));
  workers.forEach(c => c.send({ cmd: 'close' }));
  obs.close(); admin.close();
  setTimeout(() => process.exit(0), 1000);
})();
