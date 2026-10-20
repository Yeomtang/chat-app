// ══════════════════════════════════
//  LED 공용 모션 (led.html · led-concert.html 공용)
//  화면별 DOM 연결은 각 페이지에서, 움직임 계산·타이밍은 여기서 관리한다.
//  (세로형/가로형이 같은 연출을 하도록 한 곳에서만 고친다)
// ══════════════════════════════════
(function () {
  'use strict';

  const reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  // 방송 카메라·멀미 배려: OS 설정이 "동작 줄이기"면 장식 모션을 생략/단축
  function prefersReduced() { return !!(reduceQuery && reduceQuery.matches); }

  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  // 시안(demo.html)과 같은 이징
  const easeBack = (t) => { t = clamp01(t); const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const ease = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  // 질문 화면 계열 모드 (이 밖의 모드에서 들어올 때만 질문 등장 연출)
  const QUESTION_MODES = ['voting', 'result', 'subjective', 'subjectiveResult', 'emoji'];
  // 질문이 "새로 시작"되는 모드
  const QUESTION_START_MODES = ['voting', 'subjective', 'emoji'];

  // ── 질문 등장: 어절 단위로 하나씩 팝인 (시안 2) ──
  const question = {
    STAGGER: 140,     // 어절 간격(ms)
    START_DELAY: 200, // 카드 팝인이 자리 잡은 뒤 시작

    isQuestionMode(mode) { return QUESTION_MODES.includes(mode); },

    // 채팅·대기·엔딩·함성 → 질문 시작일 때만 재생.
    // 투표→결과 전환이나 재접속 때 받는 state 스냅샷에선 재생하지 않는다.
    shouldAnimate(prevMode, nextMode, isSnapshot) {
      if (isSnapshot) return false;
      return QUESTION_START_MODES.includes(nextMode) && !QUESTION_MODES.includes(prevMode);
    },

    // el에 질문을 넣는다. animate면 어절마다 .fx-word 스팬(페이지 CSS의 .in 팝인)으로 나눔.
    // 같은 질문이 다시 오면(모드 재전송 등) 진행 중인 연출을 끊지 않도록 그대로 둔다.
    render(el, text, animate) {
      text = text || '';
      if (!animate) {
        if (el.dataset.fxText === text) return;
        el.dataset.fxText = text;
        el.textContent = text;
        return;
      }
      el.dataset.fxText = text;
      el.textContent = '';
      const words = text.split(/\s+/).filter(Boolean);
      const reduce = prefersReduced();
      words.forEach((w, i) => {
        if (i > 0) el.appendChild(document.createTextNode(' ')); // 공백에서 자연스럽게 줄바꿈
        const s = document.createElement('span');
        s.className = 'fx-word';
        s.textContent = w;
        // 동작 줄이기면 페이지 CSS가 애니메이션 없이 바로 보이게 처리
        if (!reduce) s.style.animationDelay = (question.START_DELAY + i * question.STAGGER) + 'ms';
        s.classList.add('in');
        el.appendChild(s);
      });
    },
  };

  // ── 타이머 긴장감: 마지막 5초 경고색 + 1초 맥박 (시안 2) ──
  const timer = {
    HOT_SECONDS: 5,
    // remain(초)에 맞춰 상태 클래스만 바꾼다 (모양은 페이지 CSS의 .hot)
    update(el, remain) {
      el.classList.toggle('hot', remain > 0 && remain <= timer.HOT_SECONDS);
    },
    reset(el) { el.classList.remove('hot'); },
  };

  // ── 공 낙하: 상자 헤더 바로 아래에서 제자리로 떨어져 한 번 작게 튕김 ──
  const balls = {
    DROP_MS: 560,      // 낙하+튕김 전체 시간
    IMPACT: 0.72,      // 바닥에 닿는 시점(전체 대비)
    BOUNCE_RATIO: 0.08, // 튕김 높이 = 낙하 거리 × 비율
    BOUNCE_MAX: 14,    // 튕김 높이 상한(논리 px) — 상자가 커도 "작은" 튕김 유지
    STAGGER: 35,       // 한 번에 여러 표가 들어올 때 공끼리 겹쳐 떨어지지 않게 시차(ms)
    STAGGER_MAX: 420,

    // 새 공에 낙하 정보를 붙인다. order = 이번에 함께 들어온 공 중 몇 번째인지
    startDrop(ball, fromY, order, now) {
      const delay = Math.min(balls.STAGGER_MAX, (order || 0) * balls.STAGGER);
      ball.drop = { t0: (now || performance.now()) + delay, fromY };
      ball.y = fromY;
    },

    // 낙하 중이면 위치를 계산해 넣고 true(그릴지 여부는 visible)를 돌려준다.
    // 끝나면 drop을 지워 평소처럼 목표 위치로 lerp(반지름 축소 재배치도 부드럽게)
    step(ball, now) {
      const d = ball.drop;
      if (!d) return { dropping: false, visible: true };
      const elapsed = now - d.t0;
      ball.x = ball.tx; // 재배치로 목표 x가 바뀌어도 따라감
      if (elapsed < 0) { ball.y = d.fromY; return { dropping: true, visible: false }; }
      const reduce = prefersReduced();
      const dur = reduce ? 300 : balls.DROP_MS;
      const t = elapsed / dur;
      if (t >= 1) { ball.y = ball.ty; ball.drop = null; return { dropping: false, visible: true }; }
      const dist = ball.ty - d.fromY;
      if (reduce) {
        // 동작 줄이기: 튕김 없이 짧게 내려앉기
        ball.y = d.fromY + dist * (1 - Math.pow(1 - t, 3));
      } else if (t < balls.IMPACT) {
        const g = t / balls.IMPACT;
        ball.y = d.fromY + dist * g * g; // 중력처럼 가속
      } else {
        const b = (t - balls.IMPACT) / (1 - balls.IMPACT);
        const h = Math.min(Math.abs(dist) * balls.BOUNCE_RATIO, balls.BOUNCE_MAX);
        ball.y = ball.ty - h * Math.sin(Math.PI * b); // 한 번만 작게 튕김
      }
      return { dropping: true, visible: true };
    },
  };

  // ── 하트 폭발: 3초 안 하트 40개 이상이면 가운데 큰 하트 + 링 파티클 (시안 3) ──
  const HEART_WINDOW = 3000;
  const HEART_FIRE = 40;   // 이 이상 몰리면 터짐
  const HEART_REARM = 10;  // 이 아래로 식어야 다시 터질 수 있음 (연속 폭발 방지)
  const HEART_MS = 1400;
  const HEART_MODES = ['chat', 'result', 'subjectiveResult', 'idle'];
  const RING_DOTS = 16;

  // layer: 연출을 얹을 레이어(리액션 레이어), colors: 링 색(OPTION_COLORS 순서)
  function createHeartBurst(layer, colors) {
    let recent = [];
    let armed = true;
    let enabled = true;
    let playing = false;

    function play() {
      playing = true;
      const reduce = prefersReduced();
      const W = layer.clientWidth, H = layer.clientHeight;
      const k = Math.min(W, H) / 1000; // 시안(1000px 캔버스) 대비 배율
      const root = document.createElement('div');
      root.className = 'fx-burst';
      const heart = document.createElement('div');
      heart.className = 'fx-burst-heart';
      heart.textContent = '❤️';
      heart.style.fontSize = Math.round(260 * k) + 'px';
      root.appendChild(heart);
      const dots = [];
      if (!reduce) {
        for (let i = 0; i < RING_DOTS; i++) {
          const d = document.createElement('div');
          d.className = 'fx-burst-dot';
          d.style.background = colors[i % 5];
          d.style.width = d.style.height = Math.round(20 * k) + 'px';
          root.appendChild(d);
          dots.push(d);
        }
      }
      layer.appendChild(root);

      const t0 = performance.now();
      const frame = (now) => {
        const p = (now - t0) / HEART_MS;
        if (p >= 1) { root.remove(); playing = false; return; }
        const fade = 1 - Math.max(0, p - 0.7) / 0.3; // 마지막 30% 동안 사라짐
        if (reduce) {
          // 동작 줄이기: 크기 변화·파티클 없이 잠깐 나타났다 사라짐
          heart.style.opacity = String(Math.min(1, p * 4) * fade);
        } else {
          const s = easeBack(Math.min(1, p * 2.2)) * fade;
          heart.style.opacity = String(fade);
          heart.style.transform = `translate(-50%, -50%) scale(${Math.max(0.001, s)})`;
          const r = (120 + p * 260) * k;
          const ds = Math.max(0, 1 - p);
          dots.forEach((d, i) => {
            const a = i / RING_DOTS * Math.PI * 2;
            d.style.opacity = String(fade);
            d.style.transform = `translate(-50%, -50%) translate(${Math.cos(a) * r}px, ${Math.sin(a) * r}px) scale(${ds})`;
          });
        }
        requestAnimationFrame(frame);
      };
      heart.style.transform = reduce ? 'translate(-50%, -50%)' : 'translate(-50%, -50%) scale(0.001)';
      requestAnimationFrame(frame);
    }

    return {
      setEnabled(v) { enabled = v !== false; },
      isEnabled() { return enabled; },
      // reaction 이벤트마다 호출. 하트만 세고, 허용 모드에서 조건이 맞으면 터뜨린다.
      onReaction(type, mode) {
        if (type !== 'heart') return false;
        const now = performance.now();
        recent = recent.filter((t) => now - t < HEART_WINDOW);
        if (recent.length < HEART_REARM) armed = true;
        recent.push(now);
        if (recent.length >= HEART_FIRE && armed && enabled && !playing && HEART_MODES.includes(mode)) {
          armed = false;
          play();
          return true;
        }
        return false;
      },
    };
  }

  // 연출 설정(state.effects / effectsChange)에서 하트 폭발 on/off — 값이 없으면 켬
  function heartBurstEnabled(effects) {
    return !(effects && effects.heartBurst === false);
  }

  // ── 결과 요약: 1위(동률이면 여럿)와 1위 비율 ──
  function summarize(perOption) {
    const per = (perOption || []).map((v) => Math.max(0, Number(v) || 0));
    const total = per.reduce((a, b) => a + b, 0);
    const max = per.length ? Math.max(...per) : 0;
    const top = max > 0 ? per.map((v, i) => (v === max ? i : -1)).filter((i) => i >= 0) : [];
    return { per, total, max, top, tie: top.length > 1, pct: total ? Math.round(max / total * 100) : 0 };
  }

  // 두 색을 k 비율로 섞어 '#rrggbb'로 돌려준다 (진 쪽 점 = 이긴 색의 옅은 톤, 색 전환도 부드럽게)
  function mixHex(a, b, k) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const x = p(a), y = p(b);
    return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * clamp01(k)).toString(16).padStart(2, '0')).join('');
  }

  // ── 결과 공개 (2지선다): 시안 6을 상자 화면에 맞춤 ──
  // 0~0.7s 이긴 상자 강조·진 쪽 흐려짐 / 0.7~1.5s 공이 상자 밖으로 흩어짐 /
  // 1.5~2.8s 숫자 모양으로 모임(2.5s 색종이) / 2.9~4.7s 점→면 / 1.5s 유지 / 면→점 0.5s / 1.2s 제자리 복귀
  const REVEAL = {
    EMPH: 700, SCATTER: 1500, GATHER_MS: 1100, CONFETTI: 2500,
    SOLID: 2900, SOLID_MS: 1800, UNSOLID: 6200, UNSOLID_MS: 500,
    RETURN: 6700, RETURN_MS: 1200,
  };
  REVEAL.END = REVEAL.RETURN + REVEAL.RETURN_MS;
  // 숫자 글꼴은 웹폰트 로딩과 무관한 시스템 글꼴로 고정 — 점을 뽑을 때와 면으로 그릴 때 모양이 정확히 겹치도록
  const NUM_FAMILY = "-apple-system, 'Helvetica Neue', Arial, sans-serif";

  // opts: { W, H (논리 캔버스), sides: [{ color, balls:[{tx,ty}] }], centers: [{x,y}] (상자 중심),
  //         ballR, winner(-1=동률), pct, label, labelFamily, ink, confettiColors }
  // 반환 객체의 draw(ctx, now, drawBox)를 매 프레임 부르고, true가 오면 끝(페이지가 배너 표시)
  function createReveal(opts) {
    const { W, H, ink } = opts;
    const tie = opts.winner < 0;
    const numColor = tie ? ink : opts.sides[opts.winner].color;
    const text = opts.pct + '%';

    // 숫자 크기: 캔버스 폭 78%·높이 62% 안에 들어가게
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(W)); off.height = Math.max(1, Math.round(H));
    const o = off.getContext('2d');
    o.font = '700 100px ' + NUM_FAMILY;
    const w100 = Math.max(1, o.measureText(text).width);
    const size = Math.round(Math.min(H * 0.62, W * 0.78 / w100 * 100));
    const numFont = '700 ' + size + 'px ' + NUM_FAMILY;
    const numY = H * 0.44;
    const labelSize = Math.round(Math.max(22, Math.min(52, size * 0.18)));
    const labelY = numY + size * 0.42 + labelSize;

    // 글자를 격자로 훑어 점 위치를 뽑는다
    o.font = numFont; o.textAlign = 'center'; o.textBaseline = 'middle';
    o.fillText(text, W / 2, numY);
    const step = Math.max(6, Math.round(size / 23));
    const data = o.getImageData(0, 0, off.width, off.height).data;
    const pts = [];
    for (let y = step / 2; y < off.height; y += step) {
      for (let x = step / 2; x < off.width; x += step) {
        if (data[(Math.floor(y) * off.width + Math.floor(x)) * 4 + 3] > 128) pts.push([x, y]);
      }
    }
    const dotR = step * 0.42;      // 처음엔 틈이 보이는 점
    const dotRFull = step * 0.66;  // 맞닿아 면처럼 보이는 크기

    // 공마다 집(상자 칸)·흩어질 곳·글자 점을 정한다. 공이 점보다 적으면 점을 고르게 고르고,
    // 많으면 남는 공은 숫자 구간 동안 흐려졌다 돌아올 때 다시 나타난다
    const parts = [];
    opts.sides.forEach((s, side) => s.balls.forEach((b) => parts.push({ b, side, hx: b.tx, hy: b.ty })));
    for (let i = parts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [parts[i], parts[j]] = [parts[j], parts[i]]; }
    const used = Math.min(parts.length, pts.length);
    const m = W * 0.06;
    parts.forEach((p, k) => {
      p.sx = m + Math.random() * (W - m * 2);
      p.sy = m + Math.random() * (H - m * 2);
      p.delay = (k % 40) * 6; // 한꺼번에 몰리지 않게 살짝 시차
      if (k < used) { const q = pts[Math.floor(k * pts.length / used)]; p.tx = q[0]; p.ty = q[1]; } else p.tx = null;
    });

    const confetti = [];
    let confettiDone = false;
    let t0 = null, last = null;

    function burst() {
      const k = W / 1000; // 시안(1000px) 대비 배율
      const cols = opts.confettiColors;
      for (let i = 0; i < 100; i++) {
        const a = Math.random() * Math.PI * 2, v = (4 + Math.random() * 10) * k;
        confetti.push({ x: W / 2, y: numY, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 5 * k, r: Math.random() * Math.PI, c: cols[i % 5], s: (8 + Math.random() * 9) * k, g: 0.35 * k });
      }
    }

    function draw(ctx, now, drawBox) {
      if (t0 === null) { t0 = now; last = now; }
      const t = now - t0;
      const dt = Math.min(50, now - last); last = now;
      const R = REVEAL;

      // 상자: 흩어질 때 사라졌다가 복귀할 때 다시 나타남
      const boxA = t < R.EMPH ? 1 : t < R.RETURN ? 1 - ease((t - R.EMPH) / (R.SCATTER - R.EMPH)) : ease((t - R.RETURN) / R.RETURN_MS);
      const emphP = clamp01(t / R.EMPH);
      const emphS = t < R.EMPH ? 1 + Math.sin(emphP * Math.PI) * 0.05 : 1; // 이긴 상자만 살짝 부풀었다 돌아옴
      const withScale = (side, fn) => {
        if (tie || side !== opts.winner || emphS === 1) { fn(); return; }
        const c = opts.centers[side];
        ctx.save(); ctx.translate(c.x, c.y); ctx.scale(emphS, emphS); ctx.translate(-c.x, -c.y); fn(); ctx.restore();
      };
      if (boxA > 0.001) opts.sides.forEach((s, i) => withScale(i, () => drawBox(i, boxA)));

      // 점→면: 점이 커져 맞닿고(0~40%) 그 위로 같은 모양의 글자가 차오르며 점은 사라짐(40~100%)
      const solid = t > R.SOLID && t < R.RETURN ? ease((t - R.SOLID) / R.SOLID_MS) * (1 - ease((t - R.UNSOLID) / R.UNSOLID_MS)) : 0;
      const dotAlpha = 1 - clamp01((solid - 0.4) / 0.6);
      const grownR = dotR + (dotRFull - dotR) * Math.min(1, solid / 0.4);

      // 점 색: 모이는 동안 이긴 색(진 쪽은 옅은 톤)으로, 복귀하며 원래 색으로
      const toMorph = t < R.RETURN ? ease((t - R.SCATTER) / 700) : 1 - ease((t - R.RETURN) / 800);
      const colors = opts.sides.map((s, i) => {
        const target = tie ? ink : (i === opts.winner ? numColor : mixHex(numColor, '#ffffff', 0.45));
        return toMorph <= 0 ? s.color : mixHex(s.color, target, toMorph);
      });
      const loserDim = tie ? 1 : t < R.EMPH ? 1 - 0.45 * emphP : t < R.SCATTER ? 0.55 + 0.45 * ease((t - R.EMPH) / (R.SCATTER - R.EMPH)) : 1;

      parts.forEach((p) => {
        let x, y, r, a = 1;
        const r0 = opts.ballR;
        if (t < R.EMPH) {
          x = p.hx; y = p.hy; r = r0;
        } else if (t < R.SCATTER) {
          const q = ease((t - R.EMPH) / (R.SCATTER - R.EMPH));
          x = p.hx + (p.sx - p.hx) * q; y = p.hy + (p.sy - p.hy) * q; r = r0 + (dotR - r0) * q;
        } else if (t < R.RETURN) {
          if (p.tx === null) {
            x = p.sx; y = p.sy; r = dotR; a = 1 - ease((t - R.SCATTER) / 600);
          } else {
            const q = easeBack((t - R.SCATTER - p.delay) / R.GATHER_MS);
            x = p.sx + (p.tx - p.sx) * q; y = p.sy + (p.ty - p.sy) * q; r = solid > 0 ? grownR : dotR; a = dotAlpha;
          }
        } else {
          const q = ease((t - R.RETURN) / R.RETURN_MS);
          const fx = p.tx === null ? p.sx : p.tx, fy = p.tx === null ? p.sy : p.ty;
          x = fx + (p.hx - fx) * q; y = fy + (p.hy - fy) * q; r = dotR + (r0 - dotR) * q;
          if (p.tx === null) a = q;
        }
        if (!tie && p.side !== opts.winner) a *= loserDim;
        if (a <= 0.01) return;
        p.b.x = x; p.b.y = y; // 끝나면 공이 제자리에서 그대로 이어지도록
        ctx.globalAlpha = a;
        ctx.fillStyle = colors[p.side];
        if (t < R.EMPH) {
          withScale(p.side, () => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); });
        } else {
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
      });
      ctx.globalAlpha = 1;

      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // 면이 된 글자 — 점을 뽑을 때와 같은 글꼴·크기·위치라 모양이 그대로 겹친다
      if (solid > 0) {
        ctx.globalAlpha = clamp01((solid - 0.15) / 0.85);
        ctx.font = numFont; ctx.fillStyle = numColor;
        ctx.fillText(text, W / 2, numY);
      }
      // 숫자 아래 이긴 보기 이름(동률이면 "동률")
      const labelA = t < R.RETURN ? ease((t - R.SCATTER) / 800) : 1 - ease((t - R.RETURN) / 400);
      if (labelA > 0.01) {
        ctx.globalAlpha = labelA;
        ctx.font = '700 ' + labelSize + 'px ' + opts.labelFamily;
        ctx.fillStyle = numColor;
        ctx.fillText(opts.label, W / 2, labelY, W * 0.9);
      }
      ctx.globalAlpha = 1;

      if (!confettiDone && t >= R.CONFETTI) { confettiDone = true; burst(); }
      for (let i = confetti.length - 1; i >= 0; i--) {
        const q = confetti[i];
        q.vy += q.g * dt / 16; q.x += q.vx * dt / 16; q.y += q.vy * dt / 16; q.r += 0.1 * dt / 16;
        if (q.y > H + 40) { confetti.splice(i, 1); continue; }
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.r); ctx.fillStyle = q.c; ctx.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2); ctx.restore();
      }

      if (t >= R.END) {
        parts.forEach((p) => { p.b.x = p.hx; p.b.y = p.hy; });
        return true;
      }
      return false;
    }

    return { draw, numColor, text };
  }

  // ── 객관식 3지 이상: 막대 경주 (시안 4) ──
  // 막대가 흔들리며 자라 중간에 순위가 바뀌다가, 3.2초 뒤 정렬된 결과로 확정
  const RACE_MS = 3200;

  function createBarRace(container) {
    let raf = null;
    let rows = [];

    function clear() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      rows = [];
      container.classList.remove('active');
      container.innerHTML = '';
    }

    // opts: { labels, colors, perOption, animate }
    function show(opts) {
      clear();
      const sum = summarize(opts.perOption);
      const n = opts.labels.length;
      const pcts = opts.labels.map((_, i) => (sum.total ? Math.round((sum.per[i] || 0) / sum.total * 100) : 0));
      const maxPct = Math.max(0, ...pcts);
      const scaleMax = Math.max(10, maxPct * 1.12); // 1위 막대가 트랙을 거의 채우게
      const wobbleAmp = maxPct * 0.26;
      const slot = 100 / n;
      // 최종 순서: 득표 내림차순, 같으면 보기 순서
      const finalOrder = pcts.map((v, i) => [sum.per[i] || 0, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1]);

      const area = document.createElement('div');
      area.className = 'fx-bars-area';
      rows = opts.labels.map((label, i) => {
        const r = document.createElement('div');
        r.className = 'fx-bar-row';
        r.style.height = (slot * 0.78) + '%';
        r.innerHTML = '<div class="fx-bar-label"><span class="fx-bar-name"></span><span class="fx-bar-rank">· 1위</span></div>' +
          '<div class="fx-bar-track"><div class="fx-bar-fill"></div></div><div class="fx-bar-pct">0%</div>';
        r.querySelector('.fx-bar-name').textContent = label;
        r.querySelector('.fx-bar-fill').style.background = opts.colors[i % opts.colors.length];
        area.appendChild(r);
        return r;
      });
      container.appendChild(area);

      const place = (vals, order, done) => {
        rows.forEach((r, i) => {
          r.style.top = (order.indexOf(i) * slot + slot * 0.11) + '%';
          r.querySelector('.fx-bar-fill').style.width = (vals[i] / scaleMax * 100) + '%';
          r.querySelector('.fx-bar-pct').textContent = Math.round(vals[i]) + '%';
          r.classList.toggle('win', done && sum.top.includes(i)); // 1위 동률이면 모두 표시
        });
      };

      if (!opts.animate || prefersReduced() || !sum.total) {
        place(pcts, finalOrder, true);
        container.classList.add('active');
        return;
      }
      place(pcts.map(() => 0), opts.labels.map((_, i) => i), false);
      container.classList.add('active');
      const t0 = performance.now();
      const frame = (now) => {
        const t = (now - t0) / RACE_MS;
        if (t >= 1) { raf = null; place(pcts, finalOrder, true); return; }
        // 보기마다 다른 흔들림 → 중간에 순위가 뒤집혔다가 제자리로
        const vals = pcts.map((v, i) => Math.max(0, v * ease(t) + Math.sin(t * Math.PI * 2.2 + i * 1.7) * wobbleAmp * (1 - t) * ease(t)));
        const order = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1]);
        place(vals, order, false);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    return { show, clear, isActive: () => container.classList.contains('active') };
  }

  // ══════════════════════════════════
  //  주관식: 답변 흘려보내기 · 워드클라우드 · 제작진 픽
  // ══════════════════════════════════
  // 서버 computeCloud와 같은 정규화(공백만 정리) — 흘러가는 답변과 클라우드 단어를 맞춰 보기 위해
  const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // ── 답변 흘려보내기: 대기열 + 가로 레인 (폭주해도 버리지 않고 고른 밀도로 배출) ──
  const STREAM = {
    MAX_QUEUE: 200,     // 대기열 상한 (초과 시 오래된 것부터 포기)
    LANES: 8,           // 가로 레인 수
    LANE_COOLDOWN: 3500, // 같은 레인 재사용 대기(ms) — 앞 답변과 겹치지 않을 간격
  };

  // opts: { el: 흘려보내기 레이어, scale: () => 화면 배율(--u) }
  function createAnswerStream(opts) {
    const el = opts.el;
    const scale = opts.scale || (() => 1);
    const queue = [];
    const laneBusy = new Array(STREAM.LANES).fill(0);
    let items = []; // 화면에 떠 있는 답변 { el, id, text, anim }
    let spawnTimer = null;
    let running = false;

    const laneTop = (lane) => 14 + lane * (68 / (STREAM.LANES - 1)); // 14%~82% 균등 분할

    function pickLane() {
      const now = performance.now();
      const free = [];
      for (let i = 0; i < STREAM.LANES; i++) if (laneBusy[i] <= now) free.push(i);
      // 모두 사용 중이면 가장 먼저 비는 레인
      const lane = free.length ? free[Math.floor(Math.random() * free.length)] : laneBusy.indexOf(Math.min(...laneBusy));
      laneBusy[lane] = now + STREAM.LANE_COOLDOWN;
      return lane;
    }

    // 말풍선 하나 (워드클라우드로 모일 때 오른쪽에서 들어오는 답변도 같은 모양)
    function makeBubble(text, lane) {
      const b = document.createElement('div');
      b.className = 'answer-float';
      b.textContent = text;
      b.style.fontSize = Math.round((18 + Math.random() * 12) * scale()) + 'px';
      b.style.top = laneTop(lane == null ? pickLane() : lane) + '%';
      el.appendChild(b);
      return b;
    }

    function spawn(a) {
      const b = makeBubble(a.text);
      const w = b.offsetWidth;
      const sw = el.clientWidth;
      b.style.left = sw + 'px'; // 오른쪽 밖에서 시작
      const it = { el: b, id: a.id, text: normText(a.text) };
      it.anim = b.animate([
        { transform: 'translateX(0)' },
        { transform: `translateX(${-(sw + w + 60 * scale())}px)` },
      ], { duration: 9000 + Math.random() * 5000, easing: 'linear' }); // 9~14초에 걸쳐 통과
      it.anim.onfinish = () => { b.remove(); items = items.filter((x) => x !== it); };
      items.push(it);
    }

    function schedule() {
      if (spawnTimer || !running) return;
      const tick = () => {
        if (!running || !queue.length) { spawnTimer = null; return; }
        spawn(queue.shift());
        // 밀린 답변이 많을수록 배출 간격을 자동으로 줄임
        const delay = queue.length > 60 ? 150 : queue.length > 25 ? 250 : 420;
        spawnTimer = setTimeout(tick, delay);
      };
      spawnTimer = setTimeout(tick, 50);
    }

    function stop() {
      running = false;
      queue.length = 0;
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null; }
    }

    // 흐르던 답변을 지금 보이는 자리에 멈춰 세우고 넘겨준다 (레이어 기준 좌상단 x,y)
    function detach(it) {
      const sr = el.getBoundingClientRect();
      const r = it.el.getBoundingClientRect();
      it.anim.onfinish = null;
      it.anim.cancel();
      it.el.style.left = (r.left - sr.left) + 'px';
      it.el.style.top = (r.top - sr.top) + 'px';
      items = items.filter((x) => x !== it);
      return { el: it.el, id: it.id, text: it.text, x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, rect: r };
    }

    return {
      el,
      makeBubble,
      laneTop,
      // 답변 접수 중: 대기열 배출 시작 (이미 떠 있는 답변은 그대로)
      start() { el.classList.add('active'); running = true; schedule(); },
      push(a) {
        if (!a || typeof a.text !== 'string') return;
        queue.push({ id: a.id, text: a.text });
        if (queue.length > STREAM.MAX_QUEUE) queue.shift();
        schedule();
      },
      stop,
      clear() {
        stop();
        items.forEach((it) => { it.anim.onfinish = null; it.anim.cancel(); });
        items = [];
        el.innerHTML = '';
        el.classList.remove('active');
        el.style.zIndex = '';
      },
      // 마감: 배출을 멈추고 화면의 답변을 모두 넘겨받음
      takeAll() { stop(); return items.slice().map(detach); },
      // 픽된 답변이 지금 화면에 보이는 말풍선인지 — id 우선, 없으면 같은 글 중 가운데에 가장 가까운 것
      find(id, text) {
        const sr = el.getBoundingClientRect();
        const visible = items.filter((it) => {
          const r = it.el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          return r.width > 0 && cx > sr.left && cx < sr.right;
        });
        const byId = id != null ? visible.find((it) => it.id === id) : null;
        if (byId) return byId;
        const t = normText(text);
        const mx = sr.left + sr.width / 2, my = sr.top + sr.height / 2;
        let best = null, bestD = Infinity;
        visible.forEach((it) => {
          if (it.text !== t) return;
          const r = it.el.getBoundingClientRect();
          const d = Math.hypot(r.left + r.width / 2 - mx, r.top + r.height / 2 - my);
          if (d < bestD) { bestD = d; best = it; }
        });
        return best;
      },
      take: detach,
    };
  }

  // ── 워드클라우드 (시안 7 "추천"): 흐르던 답변이 자기 단어 자리로 모이며 커짐 → 1등 비추기 → 둥실 ──
  const CLOUD = {
    FLY_MS: 1100,      // 답변 하나가 날아가는 시간
    STAGGER: 70,       // 출발 간격(ms)
    SPREAD_MAX: 2800,  // 출발 간격 총합 상한 — 답변이 많아도 모이는 시간이 너무 길어지지 않게
    MAX_FLY: 60,       // 날아가는 말풍선 상한 (나머지 수는 마지막 도착 때 한 번에 반영)
    SPOT_DELAY: 400,   // 다 모인 뒤 1등 비추기까지
    SPOT_MS: 2800,     // 1등 비추는 시간
    TOP_SCALE: 1.25,
  };
  // 빈도 비례 18~92px — 지수(^1.6)로 상위 단어가 확실히 크게 (기존 LED 공식)
  const cloudSize = (count, max) => 18 + 74 * Math.pow(max > 1 ? (count - 1) / (max - 1) : 0.5, 1.6);

  // opts: { wrap: 클라우드 영역, stream: createAnswerStream 결과, colors: CLOUD_COLORS, scale: () => --u }
  function createCloud(opts) {
    const wrap = opts.wrap, stream = opts.stream, colors = opts.colors;
    const scale = opts.scale || (() => 1);
    let key = null, data = [];
    let box = null, words = new Map(), max = 1;
    let flights = [], timers = [], raf = null, flying = false;

    const later = (fn, ms) => timers.push(setTimeout(fn, ms));

    function stopTimers() {
      timers.forEach(clearTimeout); timers = [];
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      flights = [];
    }

    // 최종 배치를 flex로 한 번 잡아 단어별 중심을 잰 뒤, 그 자리에 절대 위치로 고정한다
    // (단어가 커지는 동안 다른 단어가 밀리지 않게)
    function build(cloud) {
      wrap.innerHTML = '';
      words = new Map();
      box = document.createElement('div');
      box.className = 'fx-cloud';
      if (!cloud.length) {
        const empty = document.createElement('div');
        empty.className = 'cloud-empty';
        empty.textContent = '접수된 답변이 없습니다';
        box.appendChild(empty);
        wrap.appendChild(box);
        return;
      }
      const u = scale();
      max = cloud[0].count; // 서버가 빈도순 정렬해서 보냄
      // 큰 단어가 한쪽에 몰리지 않게 섞되, 1등은 가운데 쪽
      const rest = cloud.slice(1);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      rest.splice(Math.floor(rest.length / 2), 0, cloud[0]);
      const recs = rest.map((entry, i) => {
        const s = document.createElement('span');
        s.className = 'fx-cloud-word';
        s.textContent = entry.word;
        s.style.fontSize = Math.round(cloudSize(entry.count, max) * u) + 'px';
        s.style.color = colors[i % colors.length]; // 표시 순서대로 팔레트 순환 — 이웃끼리 다른 색
        box.appendChild(s);
        return { el: s, word: normText(entry.word), count: entry.count, shown: 0 };
      });
      wrap.appendChild(box);
      // offset*은 정수로 반올림돼 폭을 그대로 쓰면 줄이 바뀔 수 있어 실제 사각형으로 잰다
      // (영역 팝인 배율이 걸려 있을 수 있어 그 배율로 나눔)
      const bb = box.getBoundingClientRect();
      const k = bb.width / (box.offsetWidth || 1) || 1;
      const m = recs.map((r) => { const q = r.el.getBoundingClientRect(); return { x: (q.left - bb.left + q.width / 2) / k, y: (q.top - bb.top + q.height / 2) / k, w: q.width / k, h: q.height / k }; });
      box.style.width = box.offsetWidth + 'px';
      box.style.height = box.offsetHeight + 'px';
      box.classList.add('placed');
      recs.forEach((r, i) => {
        // 랜덤 흩뿌림: 위아래로 어긋나게 + 살짝 기울여서 서로 다른 사람의 답변처럼 (1등은 똑바로)
        // 폭은 시안 7과 같게(±10·±15) — 이전 ±45는 고정 자리에서 이웃 단어와 겹침
        const isFirst = r.word === normText(cloud[0].word);
        r.cx = m[i].x + Math.round(Math.random() * 20 - 10) * u;
        r.cy = m[i].y + (isFirst ? 0 : Math.round(Math.random() * 30 - 15) * u);
        r.h = m[i].h;
        r.el.style.left = r.cx + 'px';
        r.el.style.top = r.cy + 'px';
        r.el.style.width = (Math.ceil(m[i].w) + 2) + 'px'; // 최종 크기 기준 줄바꿈 고정 (반올림 여유 2px, 가운데 정렬이라 티 안 남)
        r.el.style.setProperty('--rot', (isFirst ? 0 : (Math.random() * 10 - 5).toFixed(1)) + 'deg');
        if (!words.has(r.word)) words.set(r.word, r);
      });
    }

    function setShown(r, n) {
      r.shown = n;
      r.el.style.fontSize = Math.round(cloudSize(n, max) * scale()) + 'px';
    }

    function startBob() {
      if (prefersReduced()) return;
      words.forEach((r) => {
        r.el.classList.remove('pop', 'bump');
        const d = 4 + Math.random() * 3; // 4~7초 주기, 단어마다 다른 위상
        r.el.style.setProperty('--bd', d.toFixed(2) + 's');
        r.el.style.setProperty('--bdl', (-Math.random() * d).toFixed(2) + 's');
        r.el.classList.add('bob');
      });
    }

    // 1등 비추기: 나머지는 흐리게, 1등(동률이면 모두)은 1.25배 + "N명이 같은 답"
    function spotlightTop(done) {
      const tops = [...words.values()].filter((r) => r.count === max);
      if (max <= 1 || !tops.length) { done(); return; } // 전부 1명씩이면 생략
      const pills = [];
      words.forEach((r) => {
        r.el.classList.remove('pop', 'bump');
        if (r.count === max) r.el.style.setProperty('--s', String(CLOUD.TOP_SCALE));
        else r.el.classList.add('dim');
      });
      tops.forEach((r) => {
        const p = document.createElement('div');
        p.className = 'fx-cloud-count';
        p.textContent = `${max}명이 같은 답`;
        p.style.left = r.cx + 'px';
        p.style.top = (r.cy + r.h * 0.75) + 'px';
        box.appendChild(p);
        pills.push(p);
      });
      requestAnimationFrame(() => requestAnimationFrame(() => pills.forEach((p) => p.classList.add('on'))));
      later(() => {
        words.forEach((r) => { r.el.classList.remove('dim'); r.el.style.setProperty('--s', '1'); });
        pills.forEach((p) => p.classList.remove('on'));
        later(() => pills.forEach((p) => p.remove()), 600);
        done();
      }, CLOUD.SPOT_MS);
    }

    // 도착: 처음이면 팝인으로 등장, 이후엔 한 단계씩 커지며 통통 (마지막 도착이면 최종 크기로)
    function arrive(r, last) {
      const first = r.shown === 0;
      setShown(r, last ? r.count : Math.min(r.count, r.shown + 1));
      r.el.classList.remove('pop', 'bump');
      void r.el.offsetWidth; // 연속 도착 시 애니메이션 재시작
      r.el.classList.add('in', first ? 'pop' : 'bump');
    }

    function frame(now) {
      const u = scale();
      flights.forEach((f) => {
        if (f.done || now < f.t0) return;
        const p = Math.min(1, (now - f.t0) / CLOUD.FLY_MS);
        const e = 1 - Math.pow(1 - p, 3);
        if (f.el) {
          const x = f.sx + (f.tx - f.sx) * e;
          const y = f.sy + (f.ty - f.sy) * e - Math.sin(p * Math.PI) * 40 * u; // 살짝 포물선
          f.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${1 - 0.5 * e})`;
          f.el.style.opacity = String(1 - Math.max(0, (p - 0.6) / 0.4));
        }
        if (p >= 1) {
          f.done = true;
          if (f.el) f.el.remove();
          arrive(f.word, f.last);
        }
      });
      if (flights.every((f) => f.done)) { raf = null; landed(); return; }
      raf = requestAnimationFrame(frame);
    }

    function finalState(bob) {
      words.forEach((r) => { setShown(r, r.count); r.el.classList.add('in'); });
      if (bob) startBob();
    }

    // 실시간 마감: 흐르던 답변 → 자기 단어로 / 모자란 수는 오른쪽에서 빠르게 들어옴
    function fly() {
      const taken = stream.takeAll();
      const sr = stream.el.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      // 단어 중심(클라우드 영역) → 흘려보내기 레이어 좌표
      const target = (r) => ({ x: br.left - sr.left + r.cx, y: br.top - sr.top + r.cy });
      const planned = new Map();
      const n = (r) => planned.get(r) || 0;
      const plan = [];
      const fade = (el) => {
        el.style.transition = 'opacity 0.5s ease';
        el.style.opacity = '0';
        later(() => el.remove(), 550);
      };
      taken.sort((a, b) => a.x - b.x).forEach((t) => {
        const r = words.get(t.text);
        if (r && n(r) < r.count && plan.length < CLOUD.MAX_FLY) { plan.push({ src: t, word: r }); planned.set(r, n(r) + 1); }
        else fade(t.el); // 상위 40개 밖이거나 상한 초과 → 그냥 사라짐 (수는 도착 때 반영)
      });
      // 남은 수: 아직 한 번도 안 온 단어부터, 이후엔 돌아가며 하나씩 — 날아가는 말풍선은 상한까지만
      const list = [...words.values()];
      const extra = [];
      const give = (r) => { extra.push({ src: null, word: r }); planned.set(r, n(r) + 1); };
      list.forEach((r) => { if (plan.length + extra.length < CLOUD.MAX_FLY && n(r) === 0 && r.count > 0) give(r); });
      let more = true;
      while (more && plan.length + extra.length < CLOUD.MAX_FLY) {
        more = false;
        for (const r of list) {
          if (plan.length + extra.length >= CLOUD.MAX_FLY) break;
          if (n(r) < r.count) { give(r); more = true; }
        }
      }
      for (let i = extra.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [extra[i], extra[j]] = [extra[j], extra[i]]; }
      // 상한 때문에 하나도 못 받은 단어는 말풍선 없이 제자리에서 등장
      const silent = list.filter((r) => n(r) === 0).map((r) => ({ src: null, word: r, silent: true }));
      const all = plan.concat(extra, silent);
      const lastIdx = new Map();
      all.forEach((p, i) => lastIdx.set(p.word, i));

      const stagger = Math.min(CLOUD.STAGGER, CLOUD.SPREAD_MAX / Math.max(1, all.length));
      const now = performance.now();
      const u = scale();
      const sw = stream.el.clientWidth;
      stream.el.style.zIndex = '2'; // 모이는 말풍선이 클라우드 위로 지나가게
      // 단어는 첫 도착 크기에서 시작 (최종 크기에서 줄어드는 전환이 보이지 않게 전환 없이)
      words.forEach((r) => {
        r.el.style.transition = 'none';
        setShown(r, 1);
        r.shown = 0;
        void r.el.offsetWidth;
        r.el.style.transition = '';
      });
      flights = all.map((p, k) => {
        const t = target(p.word);
        const f = { word: p.word, last: lastIdx.get(p.word) === k, t0: now + k * stagger, tx: t.x, ty: t.y, el: null };
        if (p.src) {
          f.el = p.src.el;
          f.sx = p.src.x + p.src.w / 2; f.sy = p.src.y + p.src.h / 2;
          Object.assign(f.el.style, { left: '0px', top: '0px', transform: `translate(${f.sx}px, ${f.sy}px) translate(-50%, -50%)` });
        } else if (!p.silent) {
          // 아직 접수 중이던 답변: 출발 시각에 오른쪽 끝 밖에서 만들어져 들어옴
          f.t0 = Infinity;
          later(() => {
            const el = stream.makeBubble(p.word.word);
            const top = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
            f.sx = sw + w / 2 + (k % 6) * 40 * u; f.sy = top + h / 2;
            Object.assign(el.style, { left: '0px', top: '0px', transform: `translate(${f.sx}px, ${f.sy}px) translate(-50%, -50%)` });
            f.el = el;
            f.t0 = performance.now();
          }, k * stagger);
        }
        return f;
      });
      raf = requestAnimationFrame(frame);
    }

    // 모두 도착 → 흘려보내기 정리 → 1등 비추기 → 둥실
    function landed() {
      flying = false;
      stream.clear();
      later(() => spotlightTop(startBob), CLOUD.SPOT_DELAY);
    }

    function clear() {
      stopTimers();
      if (flying) stream.clear();
      flying = false;
      key = null;
      data = [];
      box = null;
      words = new Map();
      wrap.innerHTML = '';
      wrap.classList.remove('active');
      wrap.style.animation = '';
    }

    // cloud: 서버의 상위 40개(빈도 내림차순). live: 접수 중 화면에서 실시간으로 마감된 경우만 true
    function show(cloud, o) {
      cloud = Array.isArray(cloud) ? cloud : [];
      const k = JSON.stringify(cloud);
      if (k === key && wrap.classList.contains('active')) return; // 같은 결과 재전송 — 진행 중 연출 유지
      const live = !!(o && o.live) && !prefersReduced();
      clear();
      key = k; data = cloud;
      wrap.classList.add('active');
      if (live) wrap.style.animation = 'none'; // 자리 계산이 팝인 배율에 흔들리지 않게 (등장은 단어별로)
      build(cloud);
      if (!live || !words.size) {
        stream.clear();
        finalState(true);
        return;
      }
      flying = true;
      fly();
    }

    return {
      show,
      clear,
      // 창 크기가 바뀌면 자리 계산이 어긋나므로 최종 모습으로 다시 배치
      relayout() {
        if (key === null) return;
        const cloud = data;
        clear();
        show(cloud, { live: false });
      },
      isActive: () => key !== null,
    };
  }

  // ── 제작진 픽 스포트라이트 (시안 10): 흐르던 답변이 남색으로 물든 뒤 가운데 카드로 늘어남 ──
  const PICK = {
    LIFT_MS: 1450,
    TINT: 0.24,      // 제자리에서 물드는 구간(전체 대비)
    COVER_AT: 0.25,  // 배경 가림막이 깔리기 시작하는 시점
    OUT_MS: 500,     // 교체: 기존 카드가 위로 빠짐
    HIDE_MS: 700,    // 자동 해제: 작아지며 사라짐
  };
  const TINT_EASE = 'cubic-bezier(.4,0,.2,1)';
  const GLIDE_EASE = 'cubic-bezier(.22,.75,.25,1)';

  // opts: { layer: 스포트라이트 레이어(가운데 정렬 flex), cardClass, stream, duration, scale }
  function createPickSpotlight(opts) {
    const layer = opts.layer, stream = opts.stream;
    const cardClass = opts.cardClass || 'spotlight-card';
    const duration = opts.duration || 8000;
    const scale = opts.scale || (() => 1);
    let cover = null, card = null, lift = null, hideTimer = null, offTimer = null;

    function fadeCover(to, ms, delay) {
      if (!cover) {
        cover = document.createElement('div');
        cover.className = 'fx-pick-cover';
        layer.prepend(cover);
      }
      const from = getComputedStyle(cover).opacity;
      cover.getAnimations().forEach((a) => a.cancel());
      cover.style.opacity = from;
      const a = cover.animate([{ opacity: from }, { opacity: to }], { duration: ms, delay: delay || 0, fill: 'forwards', easing: 'ease' });
      a.onfinish = () => { cover.style.opacity = String(to); a.cancel(); };
    }

    // 텍스트 노드의 화면상 사각형 (줄이 여럿이면 전체를 감싸는 사각형)
    function textRect(el) {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getBoundingClientRect();
    }

    // 사라지는 카드는 지금 자리에 고정해 흐름에서 뺀다 (새 카드가 가운데 자리를 바로 차지하도록)
    function pinInPlace(c) {
      const lr = layer.getBoundingClientRect();
      const r = c.getBoundingClientRect();
      c.classList.remove('pop');
      Object.assign(c.style, { position: 'absolute', left: (r.left - lr.left) + 'px', top: (r.top - lr.top) + 'px', width: r.width + 'px', margin: '0' });
    }

    function releaseUp(c) {
      pinInPlace(c);
      if (prefersReduced()) { c.remove(); return; }
      c.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-60 * scale()}px)` }],
        { duration: PICK.OUT_MS, fill: 'forwards', easing: TINT_EASE }).onfinish = () => c.remove();
    }

    // 말풍선 → 카드: 물들기(0~24%) 후 상자가 카드 위치·크기·여백·글자 크기로 변하고,
    // 글자는 카드와 같은 정렬·줄 간격·굵기로 끝까지 보인 채 이동 → 다 커진 순간 똑같은 카드로 바꿔 끼움
    function liftFrom(src, c) {
      const lr = layer.getBoundingClientRect();
      const b = stream.take(src);
      const g = b.el;
      const bcs = getComputedStyle(g);
      const fs0 = parseFloat(bcs.fontSize);
      const py0 = parseFloat(bcs.paddingTop), px0 = parseFloat(bcs.paddingLeft);
      const bg0 = bcs.backgroundColor, color0 = bcs.color, shadow0 = bcs.boxShadow;
      const radius0 = parseFloat(bcs.borderTopLeftRadius);
      const bx = b.rect.left - lr.left + b.rect.width / 2, by = b.rect.top - lr.top + b.rect.height / 2;

      // 최종 카드 (숨긴 채 자리 잡기)
      c.style.opacity = '0';
      const ccs = getComputedStyle(c);
      const cr = c.getBoundingClientRect();
      const fs1 = parseFloat(ccs.fontSize);
      const lh = parseFloat(ccs.lineHeight) / fs1; // 줄 간격 비율
      const py1 = parseFloat(ccs.paddingTop), px1 = parseFloat(ccs.paddingLeft);
      const tr = textRect(c);
      const lines = Math.max(1, Math.round(tr.height / (lh * fs1)));
      const emW = (tr.width + 1) / fs1; // 글자 폭(em) — 글자 크기에 비례해 줄바꿈이 중간에 바뀌지 않음

      // 고스트: 흐르던 말풍선 그대로 스포트라이트 레이어로 옮김
      g.textContent = '';
      const span = document.createElement('span');
      span.textContent = b.text;
      span.style.width = emW + 'em';
      g.appendChild(span);
      g.className = 'answer-float fx-pick-ghost';
      Object.assign(g.style, { transform: 'none', opacity: '1', lineHeight: String(lh), fontWeight: ccs.fontWeight, textAlign: 'center' });
      layer.appendChild(g);

      const w0 = emW * fs0 + px0 * 2, h0 = lines * lh * fs0 + py0 * 2; // 굵기만 카드에 맞춘 원래 크기
      const start = { left: (bx - w0 / 2) + 'px', top: (by - h0 / 2) + 'px', width: w0 + 'px', height: h0 + 'px', padding: `${py0}px ${px0}px`, fontSize: fs0 + 'px', borderRadius: Math.min(radius0, h0 / 2) + 'px' };
      const end = { left: (cr.left - lr.left) + 'px', top: (cr.top - lr.top) + 'px', width: cr.width + 'px', height: cr.height + 'px', padding: `${py1}px ${px1}px`, fontSize: fs1 + 'px', borderRadius: ccs.borderTopLeftRadius };
      const o = { duration: PICK.LIFT_MS, easing: 'linear', fill: 'forwards' };
      const box = g.animate([
        { ...start, backgroundColor: bg0, boxShadow: shadow0, easing: TINT_EASE },
        { ...start, backgroundColor: ccs.backgroundColor, boxShadow: shadow0, offset: PICK.TINT, easing: GLIDE_EASE },
        { ...end, backgroundColor: ccs.backgroundColor, boxShadow: ccs.boxShadow },
      ], o);
      // 글자: 선택 순간 카드 글자색으로 바뀐 뒤 끝까지 그대로 (사라지거나 겹치지 않음)
      const ink = g.animate([{ color: color0, easing: TINT_EASE }, { color: ccs.color, offset: PICK.TINT }, { color: ccs.color }], o);
      fadeCover(1, PICK.LIFT_MS * (1 - PICK.COVER_AT), PICK.LIFT_MS * PICK.COVER_AT);
      const l = { done: false };
      const swap = () => {
        if (l.done) return;
        l.done = true;
        c.style.opacity = ''; // 다 커진 순간 모양이 똑같은 카드로 바꿔 끼움
        box.cancel();
        ink.cancel();
        g.remove();
        if (lift === l) lift = null;
      };
      box.onfinish = swap;
      // 들어올리는 중에 다음 픽·해제가 오면 그 자리에서 바로 카드 상태로 (onfinish는 비동기라 직접 바꿈)
      l.finish = () => { box.onfinish = null; swap(); };
      lift = l;
    }

    function popIn(c) {
      if (!prefersReduced()) c.classList.add('pop');
      fadeCover(1, prefersReduced() ? 1 : 400, 0);
    }

    function hide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (lift) lift.finish();
      const c = card;
      card = null;
      if (!c) return;
      const reduce = prefersReduced();
      if (reduce) c.remove();
      else {
        pinInPlace(c);
        c.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.94)' }],
          { duration: PICK.HIDE_MS, fill: 'forwards', easing: TINT_EASE }).onfinish = () => c.remove();
      }
      fadeCover(0, reduce ? 1 : PICK.HIDE_MS, 0);
      offTimer = setTimeout(() => { offTimer = null; if (!card) layer.classList.remove('active'); }, reduce ? 0 : PICK.HIDE_MS + 50);
    }

    return {
      // data: answerPicked { id, text }
      pick(data) {
        if (!data || typeof data.text !== 'string') return;
        if (offTimer) { clearTimeout(offTimer); offTimer = null; }
        if (lift) lift.finish(); // 들어올리던 중이면 바로 카드 상태로
        if (card) releaseUp(card); // 교체: 기존 카드는 위로 빠지며 사라짐
        layer.classList.add('active');
        const c = document.createElement('div');
        c.className = cardClass;
        c.textContent = data.text;
        layer.appendChild(c);
        card = c;
        const src = !prefersReduced() && stream ? stream.find(data.id, data.text) : null;
        if (src) liftFrom(src, c); else popIn(c);
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, duration);
      },
      hide,
      clear() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (offTimer) { clearTimeout(offTimer); offTimer = null; }
        lift = null;
        card = null;
        cover = null;
        layer.innerHTML = '';
        layer.classList.remove('active');
      },
    };
  }

  window.LedFx = {
    prefersReduced,
    easeBack,
    question,
    timer,
    balls,
    hearts: { create: createHeartBurst, enabledFrom: heartBurstEnabled, MODES: HEART_MODES },
    result: { summarize, createReveal, createBarRace, REVEAL, RACE_MS },
    answers: { create: createAnswerStream, normalize: normText, STREAM },
    cloud: { create: createCloud, size: cloudSize, CLOUD },
    spotlight: { create: createPickSpotlight, PICK },
  };
})();
