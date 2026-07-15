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
const MAX_CHAT_LENGTH = 100; // 채팅 글자 수 제한 (클라이언트 제한 우회 대비 서버에서도 자름)

// ── 투표(질문) 상태 관리 ──
// mode: 'chat' | 'voting' | 'result' | 'subjective' | 'subjectiveResult'
//  - voting/result: 객관식(Yes/No)
//  - subjective/subjectiveResult: 주관식(자유 텍스트, 제작진 수동 마감 → 워드클라우드)
const appState = {
  mode: 'chat',
  question: null,
  votingDuration: null,   // 초 (객관식 전용)
  votingEndTime: null,    // epoch ms (객관식 전용)
  votes: {},              // clientId -> 'yes' | 'no'
  answers: {},            // clientId -> text (주관식, 1인 1회)
  answerList: [],         // [{id, text}] 도착 순서 (관리자 목록/픽용)
  pickedAnswers: [],      // 픽된 답변 id 목록 (픽 순서)
  starredAnswers: [],     // 별표(후보) 답변 id 목록 — 작가 1차 선별용, 관리자끼리 공유
  timerHandle: null,
  chatPaused: false,      // LED 화면 채팅 표시 일시정지 여부 (관리자 화면에서 제어, 관객 채팅 송수신엔 영향 없음)
};

const MAX_ANSWER_LENGTH = 20; // 주관식 답변 글자 수 제한

// 주관식 답변 → 워드클라우드용 빈도 집계 (상위 40개)
// 단어로 쪼개지 않고 답변 전체를 한 덩어리로 집계 — "나 빼고 다" 같은 문구형 답변의
// 어순/의미가 보존되고, 같은 답변을 쓴 사람이 많을수록 그 문구가 커진다.
function computeCloud() {
  const freq = new Map(); // 정규화 문구 -> { word, count }
  for (const text of Object.values(appState.answers)) {
    const norm = text.replace(/\s+/g, ' ').trim(); // 공백만 정리
    if (!norm) continue;
    const entry = freq.get(norm);
    if (entry) entry.count += 1;
    else freq.set(norm, { word: norm, count: 1 });
  }
  return [...freq.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
}

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
    answerCount: Object.keys(appState.answers).length,
    myAnswered: forClientId ? !!appState.answers[forClientId] : null,
    cloud: appState.mode === 'subjectiveResult' ? computeCloud() : null,
    chatPaused: appState.chatPaused,
  };
}

function startVoting(question, duration) {
  if (appState.timerHandle) clearTimeout(appState.timerHandle);
  appState.mode = 'voting';
  appState.question = question;
  appState.votingDuration = duration;
  appState.votingEndTime = Date.now() + duration * 1000;
  appState.votes = {};
  appState.answers = {};
  appState.answerList = [];
  appState.pickedAnswers = [];
  appState.starredAnswers = [];
  io.emit('modeChange', publicState());

  appState.timerHandle = setTimeout(() => {
    endVoting();
  }, duration * 1000);
}

// ── 주관식 질문 (타이머 없음, 제작진 수동 마감) ──
function startSubjective(question) {
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.mode = 'subjective';
  appState.question = question;
  appState.votingDuration = null;
  appState.votingEndTime = null;
  appState.votes = {};
  appState.answers = {};
  appState.answerList = [];
  appState.pickedAnswers = [];
  appState.starredAnswers = [];
  io.emit('modeChange', publicState());
}

function endSubjective() {
  if (appState.mode !== 'subjective') return;
  appState.mode = 'subjectiveResult';
  io.emit('modeChange', publicState()); // cloud 포함됨
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
  appState.answers = {};
  appState.answerList = [];
  appState.pickedAnswers = [];
  appState.starredAnswers = [];
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
    const text = (typeof data.text === 'string' ? data.text : '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;
    const message = {
      id: Date.now(),
      nickname: data.nickname,
      text,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    };
    recentMessages.push(message);
    if (recentMessages.length > MAX_MESSAGES) recentMessages.shift();
    io.emit('chat', message);
  });

  // 리액션 (하트/붐업/붐따) — LED 화면에 떠오르는 이모지 효과
  // 채팅 모드: 하트/붐업, 결과 모드: 붐업/붐따로 결과에 반응
  // 투표 중엔 차단(답변에만 집중), 소켓당 3초에 10회로 스팸 제한
  socket.on('reaction', (data) => {
    const { type } = data || {};
    if (appState.mode === 'voting' || appState.mode === 'subjective') return; // 답변 집중 구간엔 차단
    if (type !== 'heart' && type !== 'thumbs' && type !== 'down') return;
    const now = Date.now();
    if (!socket._reactionTimes) socket._reactionTimes = [];
    socket._reactionTimes = socket._reactionTimes.filter(t => now - t < 3000);
    if (socket._reactionTimes.length >= 10) return;
    socket._reactionTimes.push(now);
    io.emit('reaction', { type });
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

  // 주관식 답변 (1인 1회, 20자 제한)
  socket.on('answer', (data) => {
    if (appState.mode !== 'subjective') return;
    if (!socket.clientId) return;
    if (appState.answers[socket.clientId]) return; // 이미 답변함
    const text = (typeof (data && data.text) === 'string' ? data.text : '')
      .trim().slice(0, MAX_ANSWER_LENGTH);
    if (!text) return;

    appState.answers[socket.clientId] = text;
    const entry = { id: appState.answerList.length + 1, text };
    appState.answerList.push(entry);
    // LED 흘려보내기 + 관리자 목록/카운트용 (익명: 텍스트만 공개)
    io.emit('subjectiveAnswer', {
      id: entry.id,
      text,
      answerCount: Object.keys(appState.answers).length,
    });
    socket.emit('answerAccepted'); // 본인 확인용
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

  socket.on('admin:startSubjective', (data) => {
    const question = (data && data.question || '').trim();
    if (!question) return;
    startSubjective(question);
  });

  socket.on('admin:endSubjective', () => {
    endSubjective();
  });

  // 관리자: 답변 전체 목록 요청 (제작진이 훑어보고 픽하기 위함)
  socket.on('admin:getAnswers', () => {
    socket.emit('answerList', {
      answers: appState.answerList,
      picked: appState.pickedAnswers,
      starred: appState.starredAnswers,
    });
  });

  // 관리자: 별표(후보) 토글 — 작가 1차 선별용, 모든 관리자 화면에 공유
  socket.on('admin:toggleStar', (data) => {
    const id = data && data.id;
    const entry = appState.answerList.find(a => a.id === id);
    if (!entry) return;
    const idx = appState.starredAnswers.indexOf(id);
    const starred = idx === -1;
    if (starred) appState.starredAnswers.push(id);
    else appState.starredAnswers.splice(idx, 1);
    io.emit('answerStarred', { id, starred });
  });

  // 관리자: 답변 픽 → LED 스포트라이트로 크게 표시 (접수 중/마감 후 모두 가능)
  socket.on('admin:pickAnswer', (data) => {
    const id = data && data.id;
    if (appState.mode !== 'subjective' && appState.mode !== 'subjectiveResult') return;
    const entry = appState.answerList.find(a => a.id === id);
    if (!entry) return;
    if (!appState.pickedAnswers.includes(id)) appState.pickedAnswers.push(id);
    io.emit('answerPicked', { id: entry.id, text: entry.text });
  });

  socket.on('admin:returnToChat', () => {
    returnToChat();
  });

  socket.on('admin:getState', () => {
    socket.emit('state', publicState(null));
  });

  // LED 화면의 채팅 표시만 멈춤/재생. 관객 쪽 채팅 송수신은 계속 정상 동작.
  socket.on('admin:pauseChat', () => {
    appState.chatPaused = true;
    io.emit('chatPauseChange', { chatPaused: true });
  });

  socket.on('admin:resumeChat', () => {
    appState.chatPaused = false;
    io.emit('chatPauseChange', { chatPaused: false });
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
