# Bug report: shell lifecycle 인식 (auto-background / UI-kill)

> 조사 세션 transcript: `~/.claude/projects/-Users-user-Desktop-wikit-web/506163a4-…jsonl`
> 대상 커밋: `65a02f4` 기준.

---

## ✅ Bug #1 (RESOLVED) — harness auto-background launch 미인식

처음 조사 시점엔 `parseShells`가 background shell을 **입력 파라미터
`run_in_background === true`** 로만 인식해서, harness가 그 플래그 없이 자동 백그라운드 처리한
명령(긴 출력·장기 실행)이 statusline에 안 떴다.

**이미 수정됨** — 커밋 `65a02f4 "Recognize harness auto-backgrounded shell launches"`:

- 모든 Bash launch를 등록: `if (b.name === "Bash" && b.id)`
- launch 판정을 결과 텍스트 선두 anchor로: `^\s*Command running in background with ID:` —
  foreground 명령이 자기 출력에 에코 텍스트를 섞어 spoof하는 것 방지.

설치된 dist(`~/.claude/whatsinmycontext/dist`)에도 반영 확인. → **별도 조치 불필요.**

---

## ✅ Bug #2 (RESOLVED) — UI로 kill한 shell이 계속 "running"으로 노출됨

### 증상

Claude Code UI에서 background shell을 X 버튼으로 직접 kill하면, Claude Code 자체 shell count에선
즉시 빠지지만 whatsinmycontext에는 **여전히 running 으로 남아 over-count** 된다.

재현: 아래 두 shell을 UI에서 kill했는데 whatsinmycontext는 계속 표시 → 실제 2 shells 인데 4로 보임.

- `b1ioiduvd` — `npx vitest run … template-load-layout … (멀티파일)`
- `bjnyi0yjx` — `while kill -0 %1 …` (watchdog)

### 근본 원인

`parseShells`는 shell의 **종료(liveness)** 를 오직 transcript의 두 신호로만 판정한다:

1. `KillShell` / `TaskStop` **tool_use** (에이전트가 프로그램적으로 kill)
2. `task-notification` attachment의 `<status>completed|failed|killed</status>` (백그라운드 task의
   자연 종료/완료 알림)

그런데 **사용자가 UI에서 직접 kill하면 이 둘 중 어느 것도 transcript에 남지 않는다.** 그 결과
shell은 영원히 `status: "running"` 으로 남아 렌더된다.

### 근거 (transcript ground truth)

UI-kill한 두 shell에 대해, 종료를 알릴 어떤 구조적 신호도 없음:

```
b1ioiduvd  → TaskStop/KillShell target?  없음   |  task-notification?  없음
bjnyi0yjx  → TaskStop/KillShell target?  없음   |  task-notification?  없음
```

(비교: 정상 완료/프로그램 kill된 다른 shell들 — `b66q1b8bp`, `btugsq1dr`, `be3fokwyc` 등 — 은
모두 대응하는 `task-notification <status>` 가 transcript에 있어 정확히 completed/killed로 잡힘.)

설치된 파서를 현재 transcript에 직접 실행하면 위 두 shell이 `status:"running"` 으로 나온다(확인됨).

### 데이터 가용성 정리 (왜 transcript만으론 못 잡나)

whatsinmycontext가 접근 가능한 소스 중 UI-kill을 알 수 있는 신호가 없다:

- **statusLine stdin** (`renderFromStatusJSON`이 받는 JSON): `context_window`, `session_id`,
  `transcript_path` 뿐 — **live shell 목록 미포함**.
- **transcript**: 위처럼 UI-kill 종료 이벤트 없음.
- **`<sessionDir>/tasks/<id>.output`**: shell별로 존재하나 내용/`mtime` 뿐, alive/dead 마커 없음
  (조용한 장기 실행 job도 mtime이 오래되어 staleness로 구분 불가).
- **`readTasks`가 읽는 dump**(`wimc-subagents-<id>.json`): **서브에이전트 전용**, shell 무관.

→ 즉 현재 구조에서 transcript만으로는 UI-kill을 신뢰성 있게 감지할 수 없다.

### 수정 방향 (후보)

**A. Claude Code 측 신호 확보 (가장 정확, 권장)**
- (a) UI-kill 시 transcript에 종료 이벤트(예: `<status>killed</status>` task-notification 또는
  TaskStop 동등 entry)를 남기거나,
- (b) statusLine stdin payload에 **현재 live background shell 목록**을 포함.
- 둘 중 하나가 생기면 whatsinmycontext가 그대로 신뢰 가능. (whatsinmycontext 단독으론 한계.)

**B. whatsinmycontext 측 휴리스틱 (당장 가능, 불완전)**
- 각 "running" shell에 대해 실제 OS 프로세스 생존 확인 — 단 PID를 보관하지 않아 매칭이 어렵고
  플랫폼 의존적.
- `tasks/<id>.output` `mtime` 기반 staleness 컷오프 — 장기 실행 dev server를 오탐(dead로) 처리할
  위험이 커 권장하지 않음.

**결론**: 정확한 해결은 **A** (Claude Code가 UI-kill을 transcript/stdin에 노출). 그 전까지는 B의
휴리스틱은 trade-off가 커서 신중해야 함. 최소한 이 한계를 README/DESIGN에 명시하는 것을 권장.

### 회귀 방지 테스트 제안

- fixture에 "UI-kill 시뮬레이션" 케이스 추가는 transcript 신호가 없으므로 불가 — 대신 A안 채택 시
  그 신호(killed task-notification without prior TaskStop / stdin live-shells)에 대한 파싱 테스트를
  추가.

---

## ✔️ 해결 (2026-06-15) — OS 레벨 liveness 체크 (`lsof`)

처음 보고서는 "transcript만으론 못 잡으니 upstream(A) 필요"로 결론냈지만, **재검토 결과 transcript
밖에 신뢰 가능한 신호가 있었다.** 보고서가 후보 B에서 "프로세스 생존 확인 — PID 미보관, 플랫폼 의존"
이라며 너무 빨리 접은 부분이다.

### 핵심 관찰

harness는 background shell의 stdout/stderr를 `tasks/<id>.output` 파일로 **프로세스 수명 내내 열어둔
채** 리다이렉트한다. 따라서:

- 살아있는 shell → 그 `.output`를 연 프로세스가 있다 (`lsof -t -- <path>` → PID 반환, exit 0).
- UI-kill / crash / 정상종료된 shell → 아무도 안 연다 (`lsof` → 빈 출력, exit 1).

PID를 따로 저장할 필요가 없다. output 경로는 **launch echo에 이미 들어있다**
("Output is being written to: …/tasks/<id>.output"). 그걸 파싱해두고 렌더 시점에 `lsof`로 역추적.

결정적으로, 이건 보고서가 기각한 **mtime 오탐 문제를 해결**한다: 조용하지만 살아있는 dev server /
파일 사이 쉬는 vitest도 fd는 계속 열려있으므로 `lsof`가 정확히 alive로 본다.

### 검증 (ground truth)

| 케이스 | `lsof` | 결과 |
|---|---|---|
| 실행 중 vitest (`bzr71il4w`, 현재 live 세션) | exit 0, PID 36413 | **alive → 표시 유지** |
| UI-killed (`b1ioiduvd`, `bjnyi0yjx`) | exit 1, 빈 출력 | **dead → 드롭** |
| `.output` 파일 부재 | exit 1, 빈 출력 | dead → 드롭 |

실제 보고서 transcript(`506163a4…`)를 새 파서로 돌리면 거기 매달려있던 running shell 4개가 (지금은
프로세스가 다 죽었으므로) 전부 정확히 드롭됨 — 즉 over-count 0.

### 구현

- `src/render/liveness.ts` — `probeShellLiveness(paths[])`: `lsof`로 alive(`true`)/
  dead(`false`)/판정불가(`undefined`) 맵 반환. **fail-safe**: `lsof` 부재·timeout →
  `undefined`(살아있는 shell을 잘못 숨기지 않도록 유지 쪽으로).
- `parser`: launch echo에서 output 경로 캡처 → `ShellRecord.outputPath`.
- `build.ts buildShellViews`: running shell들의 경로를 모아 한 번에 probe —
  `true`=유지 / `false`=드롭 / `undefined`=기존 `compact_boundary` staleness 휴리스틱으로 폴백.
  (probe는 테스트용으로 주입 가능.)

### 리뷰 반영 (adversarial review hardening)

리뷰 subagent가 지적한 fragility를 실측 검증 후 반영:

- **(블로커) hot-path 비용** — 렌더마다 shell당 `lsof` spawn은 낭비. → **단일 배치 호출**(모든
  경로를 `lsof -Fan -- p1 p2 …` 한 번에) + **tmp 캐시(~2s TTL)**로 연속 렌더 시 재spawn 방지.
  (측정: 이 머신 lsof ~30ms.)
- **(블로커) reader false-positive** — `tail -f`/에디터가 output을 열고 있으면 죽은 shell이
  alive로 보임. → **write holder만 카운트**(`a` 필드 `w`/`u`). 자식 worker가 상속한 write fd는
  정상적으로 alive로 잡힘. (실측: `tail`(3r) → `false`.)
- **(should-fix) regex regression** — 경로 캡처를 메인 탐지 정규식에 붙이면 공백 경로에서 shell
  *탐지 자체*가 깨짐. → 탐지(`SHELL_START_RE`, 기존 robust 버전 유지)와 경로 캡처
  (`SHELL_OUTPUT_RE`, 공백 허용) **분리**. 경로를 못 잡아도 liveness만 폴백, 탐지는 그대로.
- **(반박) self-redirect false-negative** — 리뷰어는 `exec >log`로 재현했으나 harness는
  `zsh -c 'eval cmd > inner.log'` 패턴이라 **부모 zsh가 `.output`을 `1w`/`2w`로 끝까지 유지**
  (실측 확인). 따라서 inner redirect가 있어도 alive로 정확히 잡힘 — 코드 수정 불필요.

### 회귀 방지 테스트 (추가됨)

- `buildShellViews`: output을 아무 프로세스도 안 여는 running shell 드롭 (UI-kill repro), live shell 유지.
- live shell은 pre-compact라도 유지 (liveness가 staleness보다 우선), `undefined`면 폴백.
- `parseTranscript`: launch echo에서 `outputPath` 캡처.

### 한계

`lsof`가 `PATH`에 있어야 함(macOS/Linux 기본 포함). 없으면 liveness는 `undefined`로 떨어지고
기존 compact 폴백만 적용 — 즉 **regression은 없고**, UI-kill 즉시 정리만 못 할 뿐.

---

## ✅ Bug #3 (RESOLVED) — foreground 출력 첫 줄이 launch echo면 phantom shell로 오등록

### 증상

statusline에 실제로 돌지도 않는 shell이 떠서 20분째 "running"으로 보임:

```
shell running cd /Users/user/Desktop/...; grep -o "Co…   19m 54s
```

### 근본 원인

`SHELL_START_RE`가 **선두(`^`) 앵커만** 걸려 있었다. 그래서 foreground 명령의 **출력 첫 줄**이
launch echo와 같으면(예: `grep "Command running in background…" some.jsonl`, 또는 transcript/
fixture를 `cat`) 그 tool_result가 echo로 시작 → 진짜 launch로 오인 등록. 등록된 command는 grep
명령 자체, id/경로는 echo에서 긁힌 값(여기선 fixture의 `b0qw539vz` / `/tmp/x/tasks/...`). 종료
notification이 없으니 영원히 running.

기존 가드 주석("unknown tool_use_id면 무시")은 틀렸다 — grep/cat도 **자기 tool_use_id를 가진 Bash
호출**이라 `cmdByToolUseId`에 잡히고, 선두 앵커만으론 "첫 줄이 echo"인 경우를 못 막는다.

### 수정

`SHELL_START_RE`를 **양끝 앵커(전체 문자열 매치)** 로 변경: 진짜 launch tool_result는 echo **하나가
result 전부**다. echo 뒤에 다른 줄이 붙은 dump(grep 다중 매치, cat)는 trailing `\s*$`에서 탈락.
`.`는 개행을 안 먹으므로 multi-line dump가 단일 echo로 캡처될 수도 없다. ("To check interim
output…" 꼬리는 버전차로 optional.) id·경로 캡처도 이 정규식에 통합.

검증: 이 세션 transcript 재파싱 → 등록 shell **0개**(phantom 제거). 실제 background를 쓴 wikit-web
세션 → 41개 정상 검출(경로 41/41 캡처). 회귀 테스트로 fixture에 "grep 다중 매치 dump"(`bGREPDUMP`)
케이스 추가, 미등록 확인.

(부가: lsof liveness도 이 spoof를 잡지만 — 가짜 경로가 존재하지 않으니 dead로 드롭 — 근본 수정은
파서에서 애초에 등록하지 않는 것. 둘이 defense-in-depth.)
