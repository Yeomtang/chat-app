const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ── 닉네임 풀 (테마별 25 × 25 = 625개) ──
// chat.html의 THEMES와 같은 단어를 써야 한다. 닉네임은 클라이언트가 로컬에서 즉시 고르지만,
// 동시 접속자와 겹치면 서버가 교체해주는데 이때 테마가 다르면 엉뚱한 닉네임이 내려간다.
const NICKNAME_THEMES = {
  office: {
    prefixes: [
      '야근하는', '퇴근못한', '커피없는', '월요일싫은', '점심기다리는',
      '회의중인', '보고서쓰는', '연차쓰고싶은', '상사눈치보는', '월급날기다리는',
      '카페인의존하는', '스트레스받는', '엑셀여는', '퇴사고민하는', '메신저피하는',
      '칼퇴원하는', '야식먹는', '재택원하는', '회식싫은', '마감쫓기는',
      '탕비실숨는', '화장실피신한', '창문바라보는', '점심혼밥하는', '복사실가는',
    ],
    suffixes: [
      '사원', '대리', '과장', '차장', '부장',
      '팀장', '인턴', '계약직', '신입', '3년차',
      '5년차', '10년차', '직장인', '사무직', '영업사원',
      '기획자', '디자이너', '개발자', '마케터', '경리',
      '총무', '프리랜서', '워커', '비서', '실장',
    ],
  },
  concert: {
    // 무료·공개 공연 기준. 티켓팅/굿즈/투어(첫공·막공·올콘)/응원봉·플카 같은
    // 유료 공연·아이돌 팬덤 전제 표현은 쓰지 않는다 (어떤 행사에서든 재사용 가능하도록).
    prefixes: [
      '소문듣고온', '앞자리사수한', '광대승천한', '앙코르기다리는', '목풀고온',
      '앞사람머리피하는', '친구따라온', '퇴근하고달려온', '지방에서온', '리허설부터온',
      '심장뛰는', '눈물참는', '소리지르는', '박수치는', '세트리스트외운',
      '오늘밤설레는', '두손모은', '무대만보는', '줄서서기다린', '숨죽인',
      '인트로부터운', '노래따라하는', '발끝세운', '조명바라보는', '한곡도못참는',
    ],
    suffixes: [
      '관객', '팬', '덕후', '직관러', '떼창러',
      '관람객', '리스너', '애청자', '1열관객', '2층관객',
      '뒷줄관객', '첫관람객', '감상러', '입장객', '박수러',
      '늦덕', '입덕러', '고인물', '뉴비', '단골',
      '동행인', '혼콘러', '최애러', '응원러', '목청러',
    ],
  },
};
const DEFAULT_THEME = 'office';

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 테마별로 모든 조합 생성 후 셔플
const nicknamePools = {};
for (const [key, t] of Object.entries(NICKNAME_THEMES)) {
  nicknamePools[key] = { list: shuffle(t.prefixes.flatMap(p => t.suffixes.map(s => `${p} ${s}`))), index: 0 };
}

function assignNickname(theme) {
  const pool = nicknamePools[theme] || nicknamePools[DEFAULT_THEME];
  if (pool.index >= pool.list.length) {
    // 모두 소진되면 재셔플 (실질적으로 500명 이하에서는 발생 안 함)
    pool.list = shuffle(pool.list);
    pool.index = 0;
  }
  return pool.list[pool.index++];
}

function poolSize(theme) {
  return (nicknamePools[theme] || nicknamePools[DEFAULT_THEME]).list.length;
}

// ── 닉네임 중복 방지 ──
// 닉네임 자체는 클라이언트가 즉시 로컬에서 고르지만(빠른 UX),
// 서버는 현재 접속 중인 소켓들의 닉네임을 추적해 동시 중복만 감지/교체한다.
const activeNicknames = new Map(); // socket.id -> nickname

// ── 관객 접속자 통계 ──
// 관객만 claimNickname을 호출한다(LED는 identify만, 관리자는 둘 다 안 함)
// → 이걸 관객 식별 기준으로 삼아 LED·관리자 화면이 접속자 수에 섞이지 않게 한다.
// clientId(localStorage 영구 ID) 기준으로 세므로 한 사람이 탭을 여러 개 열어도 1명이다.
const audienceSockets = new Map(); // clientId -> 현재 열려 있는 소켓 수
let audiencePeak = 0;              // 최고 동시 접속자 수

function audienceStats() {
  return { current: audienceSockets.size, peak: audiencePeak };
}

// 접속/해제가 몰릴 때 브로드캐스트가 폭주하지 않도록 살짝 묶어서 보낸다
let audienceBroadcastTimer = null;
function broadcastAudience() {
  if (audienceBroadcastTimer) return;
  audienceBroadcastTimer = setTimeout(() => {
    audienceBroadcastTimer = null;
    io.emit('audienceStats', audienceStats());
  }, 250);
}

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
// 행사별 관객 입장 주소 — 같은 chat.html이 경로를 보고 닉네임 풀·문구를 바꾼다.
// 관리자/LED는 공유하므로 기존 '/' 와 동일한 채팅·투표에 그대로 참여한다.
app.get('/concert', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});
// 콘서트 현장 LED (4:3 가로형, 2496×1872) — 관리자/관객은 기존 것 그대로 공유
app.get('/led/concert', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'led-concert.html'));
});

// 최근 메시지 저장 (새 연결 시 보여줄 용도)
const recentMessages = [];
const MAX_MESSAGES = 50;
const MAX_CHAT_LENGTH = 100; // 채팅 글자 수 제한 (클라이언트 제한 우회 대비 서버에서도 자름)

const MAX_ANSWER_LENGTH = 20; // 주관식 답변 글자 수 상한 (LED 가독성 보호)
const MAX_NICKNAME_LENGTH = 20; // 닉네임 길이 상한 — 실제 풀은 12자 이하지만
                                // 클라이언트가 보낸 값을 그대로 쓰므로 LED 레이아웃 보호용으로 자름

// ── 투표(질문) 상태 관리 ──
// mode: 'chat' | 'voting' | 'result' | 'subjective' | 'subjectiveResult' | 'emoji'
//  - voting/result: 선택형 투표. voteType='yesno'(YES/NO 2지) 또는 'choice'(N지선다 2~6지)
//  - subjective/subjectiveResult: 주관식(자유 텍스트, 제작진 수동 마감 → 워드클라우드)
//  - emoji: 이모지 반응 질문(관객이 이모지 선택 → LED에 대량으로 떠오름, 비율 X, 분위기 고조용)
const appState = {
  mode: 'chat',
  question: null,
  votingDuration: null,   // 초 (선택형 전용)
  votingEndTime: null,    // epoch ms (선택형 전용)
  voteType: 'yesno',      // 'yesno' | 'choice' — 클라이언트 색/레이아웃 분기용
  voteOptions: ['YES', 'NO'], // 보기 라벨 배열 (yesno는 ['YES','NO'])
  votes: {},              // clientId -> 보기 인덱스(0-based)
  answers: {},            // clientId -> text (주관식, 1인 1회)
  answerList: [],         // [{id, text}] 도착 순서 (관리자 목록/픽용)
  pickedAnswers: [],      // 픽된 답변 id 목록 (픽 순서)
  starredAnswers: [],     // 별표(후보) 답변 id 목록 — 작가 1차 선별용, 관리자끼리 공유
  answerMaxLen: MAX_ANSWER_LENGTH, // 주관식 최대 글자수 (질문별 설정 가능, 1~20)
  emojiOptions: [],       // 이모지 반응 질문 보기: [{emoji, label}] (라벨=뜻, 관객 폰에 표시)
  pinnedChat: null,       // 채팅 모드에서 LED 중앙에 핀 고정된 채팅 {id, nickname, text}
  timerHandle: null,
  chatPaused: false,      // LED 화면 채팅 표시 일시정지 여부 (관리자 화면에서 제어, 관객 채팅 송수신엔 영향 없음)
};

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

// 보기별 득표 집계 → { perOption: [n0, n1, ...], total }
function computeCounts() {
  const perOption = new Array(appState.voteOptions.length).fill(0);
  let total = 0;
  for (const v of Object.values(appState.votes)) {
    if (typeof v === 'number' && v >= 0 && v < perOption.length) {
      perOption[v]++;
      total++;
    }
  }
  return { perOption, total };
}

function publicState(forClientId) {
  const myVote = forClientId != null && appState.votes[forClientId] != null
    ? appState.votes[forClientId] : null;
  return {
    mode: appState.mode,
    question: appState.question,
    votingDuration: appState.votingDuration,
    votingEndTime: appState.votingEndTime,
    voteType: appState.voteType,
    voteOptions: appState.voteOptions,
    votes: appState.votes, // clientId -> 인덱스 (LED/관리자가 전체 분포를 그리는 데 필요)
    counts: computeCounts(),
    myVote, // 내가 고른 보기 인덱스(0-based) 또는 null
    answerCount: Object.keys(appState.answers).length,
    answerMaxLen: appState.answerMaxLen,
    emojiOptions: appState.emojiOptions,
    myAnswered: forClientId ? !!appState.answers[forClientId] : null,
    cloud: appState.mode === 'subjectiveResult' ? computeCloud() : null,
    pinnedChat: appState.pinnedChat,
    chatPaused: appState.chatPaused,
    audience: audienceStats(),
  };
}

// 질문 모드 진입/복귀 시 채팅 핀 해제 (오래된 핀이 남는 것 방지)
function clearPinnedChat() {
  if (!appState.pinnedChat) return;
  appState.pinnedChat = null;
  io.emit('chatPinned', { message: null });
}

// options: 보기 라벨 배열, type: 'yesno' | 'choice'
function startVoting(question, options, duration, type) {
  clearPinnedChat();
  if (appState.timerHandle) clearTimeout(appState.timerHandle);
  appState.mode = 'voting';
  appState.question = question;
  appState.voteType = type;
  appState.voteOptions = options;
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

// ── 이모지 반응 질문 (타이머 없음, 제작진 수동 마감=채팅 복귀) ──
// 관객이 이모지를 고르면 LED에 대량으로 떠오름(비율 X). 여러 번 탭 가능(분위기 고조).
function startEmoji(question, emojis) {
  clearPinnedChat();
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.mode = 'emoji';
  appState.question = question;
  appState.emojiOptions = emojis;
  appState.votingDuration = null;
  appState.votingEndTime = null;
  appState.votes = {};
  io.emit('modeChange', publicState());
}

// ── 주관식 질문 (타이머 없음, 제작진 수동 마감) ──
function startSubjective(question, maxLen) {
  clearPinnedChat();
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.mode = 'subjective';
  appState.question = question;
  appState.answerMaxLen = maxLen;
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
  clearPinnedChat();
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.mode = 'chat';
  appState.question = null;
  appState.votingDuration = null;
  appState.votingEndTime = null;
  appState.voteType = 'yesno';
  appState.voteOptions = ['YES', 'NO'];
  appState.votes = {};
  appState.answers = {};
  appState.answerList = [];
  appState.pickedAnswers = [];
  appState.starredAnswers = [];
  appState.answerMaxLen = MAX_ANSWER_LENGTH;
  appState.emojiOptions = [];
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
  socket.on('requestNickname', (theme) => {
    socket.emit('assignedNickname', assignNickname(theme));
  });

  // 클라이언트가 로컬에서 즉시 고른 닉네임 등록 + 동시 중복 확인
  // payload: { name, theme } — 예전 클라이언트를 위해 문자열도 허용
  socket.on('claimNickname', (payload) => {
    const name = typeof payload === 'string' ? payload : (payload && payload.name);
    const theme = (payload && payload.theme && NICKNAME_THEMES[payload.theme]) ? payload.theme : DEFAULT_THEME;
    if (!name || typeof name !== 'string') return;

    // 관객 접속 집계 — claimNickname을 처음 보낸 소켓을 관객으로 등록(리롤로 여러 번 와도 1회만)
    if (!socket.isAudience && socket.clientId) {
      socket.isAudience = true;
      audienceSockets.set(socket.clientId, (audienceSockets.get(socket.clientId) || 0) + 1);
      if (audienceSockets.size > audiencePeak) audiencePeak = audienceSockets.size;
      broadcastAudience();
    }
    if (isNicknameTaken(name, socket.id)) {
      let fresh;
      let guard = 0;
      do {
        fresh = assignNickname(theme); // 교체 닉네임도 반드시 같은 테마에서
        guard++;
      } while (isNicknameTaken(fresh, socket.id) && guard < poolSize(theme));
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
    const nickname = (typeof data.nickname === 'string' ? data.nickname : '')
      .trim().slice(0, MAX_NICKNAME_LENGTH);
    const message = {
      id: Date.now(),
      nickname,
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
    if (appState.mode === 'voting' || appState.mode === 'subjective' || appState.mode === 'emoji') return; // 답변 집중 구간엔 차단
    if (type !== 'heart' && type !== 'thumbs' && type !== 'down') return;
    const now = Date.now();
    if (!socket._reactionTimes) socket._reactionTimes = [];
    socket._reactionTimes = socket._reactionTimes.filter(t => now - t < 3000);
    if (socket._reactionTimes.length >= 10) return;
    socket._reactionTimes.push(now);
    io.emit('reaction', { type });
  });

  // 투표 (choice = 보기 인덱스 0-based)
  socket.on('vote', (data) => {
    const idx = data && data.choice;
    if (appState.mode !== 'voting') return;
    if (typeof idx !== 'number' || idx < 0 || idx >= appState.voteOptions.length) return;
    if (!socket.clientId) return;

    appState.votes[socket.clientId] = idx;
    io.emit('voteUpdate', {
      clientId: socket.clientId,
      choice: idx,
      counts: computeCounts(),
    });
  });

  // 이모지 반응 질문: 관객이 이모지 선택 → LED에 떠오름. 여러 번 탭 가능(스팸 제한).
  socket.on('emojiPick', (data) => {
    if (appState.mode !== 'emoji') return;
    const emoji = data && data.emoji;
    if (typeof emoji !== 'string' || !appState.emojiOptions.some(o => o && o.emoji === emoji)) return;
    const now = Date.now();
    if (!socket._emojiTimes) socket._emojiTimes = [];
    socket._emojiTimes = socket._emojiTimes.filter(t => now - t < 3000);
    if (socket._emojiTimes.length >= 10) return; // 3초에 10회 상한
    socket._emojiTimes.push(now);
    io.emit('emojiFloat', { emoji });
  });

  // 주관식 답변 (1인 1회, 20자 제한)
  socket.on('answer', (data) => {
    if (appState.mode !== 'subjective') return;
    if (!socket.clientId) return;
    if (appState.answers[socket.clientId]) return; // 이미 답변함
    const text = (typeof (data && data.text) === 'string' ? data.text : '')
      .trim().slice(0, appState.answerMaxLen);
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
    const type = (data && data.type) === 'choice' ? 'choice' : 'yesno';
    let options;
    if (type === 'choice') {
      options = Array.isArray(data && data.options)
        ? data.options.map(o => String(o).trim()).filter(Boolean).slice(0, 6)
        : [];
      if (options.length < 2) return; // 보기 2개 미만이면 무시
    } else {
      options = ['YES', 'NO'];
    }
    startVoting(question, options, duration, type);
  });

  socket.on('admin:endVoting', () => {
    endVoting();
  });

  socket.on('admin:startSubjective', (data) => {
    const question = (data && data.question || '').trim();
    if (!question) return;
    let maxLen = parseInt(data && data.maxLen, 10);
    if (!Number.isFinite(maxLen) || maxLen < 1) maxLen = MAX_ANSWER_LENGTH;
    maxLen = Math.min(MAX_ANSWER_LENGTH, maxLen); // 상한 20 (LED 가독성)
    startSubjective(question, maxLen);
  });

  socket.on('admin:startEmoji', (data) => {
    const question = (data && data.question || '').trim();
    if (!question) return;
    // emojis: [{emoji, label}] — 라벨(뜻)은 관객 폰 버튼에 함께 표시
    const emojiOptions = (Array.isArray(data && data.emojis) ? data.emojis : [])
      .map(o => ({ emoji: String(o && o.emoji || '').trim(), label: String(o && o.label || '').trim() }))
      .filter(o => o.emoji)
      .slice(0, 6);
    if (emojiOptions.length < 2) return; // 이모지 2개 미만이면 무시
    startEmoji(question, emojiOptions);
  });

  socket.on('admin:endSubjective', () => {
    endSubjective();
  });

  // 관리자: 채팅 핀 고정 — LED 중앙에 해당 채팅을 팝업으로 표시 (채팅 모드 전용)
  socket.on('admin:pinChat', (data) => {
    if (appState.mode !== 'chat') return;
    const nickname = (typeof (data && data.nickname) === 'string' ? data.nickname : '').slice(0, 30);
    const text = (typeof (data && data.text) === 'string' ? data.text : '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;
    appState.pinnedChat = { id: data.id || Date.now(), nickname, text };
    io.emit('chatPinned', { message: appState.pinnedChat });
  });

  socket.on('admin:unpinChat', () => {
    clearPinnedChat();
  });

  // 관리자: 채팅 기록 초기화 — 리허설 뒤 LED/관객 화면을 비우고 본 행사를 시작할 때.
  // 서버 보관본을 비워야 새로 접속하는 관객에게 옛 메시지가 history로 다시 내려가지 않는다.
  // 관리자: 접속 통계 초기화 — 최고 동시 접속을 현재값으로 되돌린다.
  // 현재 접속자는 실제 열려 있는 소켓 수라 임의로 못 지운다(peak만 리셋).
  socket.on('admin:resetAudienceStats', () => {
    audiencePeak = audienceSockets.size;
    io.emit('audienceStats', audienceStats());
  });

  socket.on('admin:clearChat', () => {
    recentMessages.length = 0;
    clearPinnedChat(); // 지워진 메시지가 LED에 핀으로 남아 있으면 안 됨
    io.emit('chatCleared');
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
    if (socket.isAudience && socket.clientId) {
      const n = (audienceSockets.get(socket.clientId) || 0) - 1;
      if (n <= 0) audienceSockets.delete(socket.clientId);
      else audienceSockets.set(socket.clientId, n);
      broadcastAudience();
    }
    console.log('연결 끊김:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`LED 화면: http://localhost:${PORT}/led`);
});
