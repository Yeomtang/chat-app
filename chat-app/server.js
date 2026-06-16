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

app.use(express.static(path.join(__dirname, 'public')));

// 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});
app.get('/led', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'led.html'));
});

// 최근 메시지 저장 (새 연결 시 보여줄 용도)
const recentMessages = [];
const MAX_MESSAGES = 50;

io.on('connection', (socket) => {
  console.log('연결됨:', socket.id);

  // 닉네임 요청 시 서버에서 고유 닉네임 배정
  socket.on('requestNickname', () => {
    socket.emit('assignedNickname', assignNickname());
  });

  // 새 연결에 최근 메시지 전송
  socket.emit('history', recentMessages);

  // 채팅 메시지
  socket.on('chat', (data) => {
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

  socket.on('disconnect', () => {
    console.log('연결 끊김:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`LED 화면: http://localhost:${PORT}/led`);
});
