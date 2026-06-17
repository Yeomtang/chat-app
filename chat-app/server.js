const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ── 닉네임 풀 생성 (25 × 25 = 625개) ──
const PREFIXES = [
  '야근하는', '퇴근못한', '커피없는', '월요일싫은', '점심기다리는',
  '회의중인', '보고서쓰는', '연차쓰고싶은', '상사눈치보는', '월급날기다리는',
  '카페인의존하는', '스트레스받는', '엑셀여는', '퇴사고민하는', '메신저피하는',
  '칼퇴원하는', '야식먹는', '재택원하는', '회식싫은', '마감쫓기는',
  '탕비실숨는', '화장실피신한', '창문바라보는', '점심혼밥하는', '복사실가는',
];
const SUFFIXES = [
  '사원', '대리', '과장', '차장', '부장',
  '팀장', '인턴', '계약직', '신입', '3년차',
  '5년차', '10년차', '직장인', '사무직', '영업사원',
  '기획자', '디자이너', '개발자', '마케터', '경리',
  '총무', '프리랜서', '워커', '비서', '실장',
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 모든 조합 생성 후 셔플
let nicknamePool = shuffle(
  PREFIXES.flatMap(p => SUFFIXES.map(s => `${p} ${s}`))
);
let poolIndex = 0;

function assignNickname() {
  if (poolIndex >= nicknamePool.length) {
    // 모두 소진되면 재셔플 (실질적으로 500명 이하에서는 발생 안 함)
    nicknamePool = shuffle(nicknamePool);
    poolIndex = 0;
  }
  return nicknamePool[poolIndex++];
}

// ── 닉네임 중복 방지 ──
// 닉네임 자체는 클라이언트가 즉시 로컬에서 고르지만(빠른 UX),
// 서버는 현재 접속 중인 소켓들의 닉네임을 추적해 동시 중복만 감지/교체한다.
const activeNicknames = new Map(); // socket.id -> nickname

function isNicknameTaken(name, excludeSocketId) {
  for (const [sid, n] of activeNicknames) {
    if (sid !== excludeSocketId && n === name) return true;
  }
  return false;
}

app.use(express.static(path.join(__dirname, 'public')));

// 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});
app.get('/led', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'led.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 최근 메시지 저장 (새 연결 시 보여줄 용도)
const recentMessages = [];
const MAX_MESSAGES = 50;

// ── 투표(질문) 상태 관리 ──
// mode: 'chat' | 'voting' | 'result'
const appState = {
  mode: 'chat',
  question: null,
  votingDuration: null,   // 초
  votingEndTime: null,    // epoch ms
  votes: {},              // clientId -> 'yes' | 'no'
  timerHandle: null,
};

function computeCounts() {
  let yes = 0, no = 0;
  for (const v of Object.values(appState.votes)) {
    if (v === 'yes') yes++;
    else if (v === 'no') no++;
  }
  return { yes, no, total: yes + no };
}

function publicState(forClientId) {
  return {
    mode: appState.mode,
    question: appState.question,
    votingDuration: appState.votingDuration,
    votingEndTime: appState.votingEndTime,
    votes: appState.votes, // clientId -> choice (LED/관리자가 전체 분포를 그리는 데 필요)
    counts: computeCounts(),
    myVote: forClientId ? (appState.votes[forClientId] || null) : null,
  };
}

function startVoting(question, duration) {
  if (appState.timerHandle) clearTimeout(appState.timerHandle);
  appState.mode = 'voting';
  appState.question = question;
  appState.votingDuration = duration;
  appState.votingEndTime = Date.now() + duration * 1000;
  appState.votes = {};
  io.emit('modeChange', publicState());

  appState.timerHandle = setTimeout(() => {
    endVoting();
  }, duration * 1000);
}

function endVoting() {
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  if (appState.mode !== 'voting') return;
  appState.mode = 'result';
  io.emit('modeChange', publicState());
}

function returnToChat() {
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.mode = 'chat';
  appState.question = null;
  appState.votingDuration = null;
  appState.votingEndTime = null;
  appState.votes = {};
  io.emit('modeChange', publicState());
}

io.on('connection', (socket) => {
  console.log('연결됨:', socket.id);
  socket.clientId = null;

  // 클라이언트 식별 (localStorage 기반 영구 ID) — 투표 중복/재접속 처리용
  socket.on('identify', (clientId) => {
    socket.clientId = clientId;
    socket.emit('state', publicState(clientId));
  });

  // 닉네임 요청 시 서버에서 고유 닉네임 배정 (레거시, 현재는 클라이언트가 즉시 로컬 배정)
  socket.on('requestNickname', () => {
    socket.emit('assignedNickname', assignNickname());
  });

  // 클라이언트가 로컬에서 즉시 고른 닉네임 등록 + 동시 중복 확인
  socket.on('claimNickname', (name) => {
    if (!name || typeof name !== 'string') return;
    if (isNicknameTaken(name, socket.id)) {
      let fresh;
      let guard = 0;
      do {
        fresh = assignNickname();
        guard++;
      } while (isNicknameTaken(fresh, socket.id) && guard < nicknamePool.length);
      activeNicknames.set(socket.id, fresh);
      socket.emit('nicknameReassigned', fresh);
    } else {
      activeNicknames.set(socket.id, name);
    }
  });

  // 새 연결에 최근 메시지 전송
  socket.emit('history', recentMessages);

  // 채팅 메시지 (채팅 모드일 때만 허용)
  socket.on('chat', (data) => {
    if (appState.mode !== 'chat') return;
    const message = {
      id: Date.now(),
      nickname: data.nickname,
      text: data.text,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    };
    recentMessages.push(message);
    if (recentMessages.length > MAX_MESSAGES) recentMessages.shift();
    io.emit('chat', message);
  });

  // 투표
  socket.on('vote', (data) => {
    const { choice } = data || {};
    if (appState.mode !== 'voting') return;
    if (choice !== 'yes' && choice !== 'no') return;
    if (!socket.clientId) return;

    appState.votes[socket.clientId] = choice;
    io.emit('voteUpdate', {
      clientId: socket.clientId,
      choice,
      counts: computeCounts(),
    });
  });

  // ── 관리자(제작진) 전용 이벤트 ──
  socket.on('admin:startVoting', (data) => {
    const question = (data && data.question || '').trim();
    const duration = Math.max(5, parseInt(data && data.duration, 10) || 30);
    if (!question) return;
    startVoting(question, duration);
  });

  socket.on('admin:endVoting', () => {
    endVoting();
  });

  socket.on('admin:returnToChat', () => {
    returnToChat();
  });

  socket.on('admin:getState', () => {
    socket.emit('state', publicState(null));
  });

  socket.on('disconnect', () => {
    activeNicknames.delete(socket.id);
    console.log('연결 끊김:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`LED 화면: http://localhost:${PORT}/led`);
});
