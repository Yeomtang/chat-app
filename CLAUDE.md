대화는 영어로 사용하지 말고 반드시 한글로 답변해주세요.

# 디자인 일관성 원칙 (필수 준수)

UI 작업 시 아래 원칙을 반드시 지킬 것. 새 요소를 만들기 전에 기존 스타일을 먼저 확인하고 재사용한다.

1. **같은 역할 = 같은 클래스**: 버튼, 카드, 배지, 입력창 등 같은 역할의 요소는 반드시 공용 클래스로 스타일링한다. 개별 id에 스타일을 지정하지 않는다 (id는 상태 변화 등 예외적인 경우만).
2. **기존 스타일 재사용 우선**: 새 UI를 추가할 때 이미 있는 클래스(.btn, .card, .expand-btn, .note, .empty-hint 등)를 먼저 찾아 쓰고, 없을 때만 새 공용 클래스를 만든다.
3. **디자인 토큰 통일**: 색상은 하드코딩하지 말고 `:root`의 CSS 변수를 쓴다 (led.html·chat.html 상단에 동일한 블러시 팔레트가 정의되어 있음 — 한쪽을 고치면 반드시 다른 쪽도 같이 고칠 것).
   - `--bg #efdcd5` 블러시 배경 / `--bg-soft #f8ece7` 보조 표면 / `--surface #ffffff` 카드·말풍선
   - `--ink #1e1e42` 네이비 본문 / `--ink-soft #6e6a86` 보조 / `--ink-faint #a49eb4` 흐림
   - `--orange #fb7e55` 1번 보기·강조 / `--purple #5b5cc4` 2번 보기 / `--warn #d94f3d` 경고
   - 3번 이후 보기 색은 led.html `OPTION_COLORS`, chat.html `OPTION_STYLES` (같은 순서 = 같은 색 유지)
   - 모서리 반경(카드 14~18px, 버튼 8~16px, 말풍선 18~20px), 여백 등도 기존 값을 따른다.
4. **한글 타이포그래피**: 폰트는 Pretendard Variable (CDN, dynamic-subset). font-weight는 700까지만 사용 (800+는 획이 뭉개짐). 텍스트 줄바꿈은 word-break: keep-all + overflow-wrap: break-word.
5. **flex 안의 input/textarea에는 min-width: 0 필수** (기본 최소 너비 때문에 좁은 화면에서 레이아웃이 깨짐).
6. **등장 애니메이션 통일**: 팝업/카드 등장은 공용 popIn 패턴(scale 0.4→1.05→1, cubic-bezier(0.34, 1.56, 0.64, 1))을 사용한다.

# 프로젝트 참고

- 프로젝트 상세 맥락과 진행 상황은 memory.md 참고 (작업 후 반드시 갱신)
- 5단계(디자인 디테일) 시작 시 금칙어 필터 추가를 사용자에게 상기시킬 것
