# 코드 구조

Paperkit은 React 화면, Tauri 어댑터, PDF 엔진을 각각 독립된 영역으로 관리합니다.

## 프론트엔드

```text
apps/desktop/src/
  main.tsx                         React 진입점
  app/
    App.tsx                        화면 조합
    layout/                        타이틀바와 앱 레이아웃
    styles.css                     전역 스타일
  features/
    file-input/
      components/                  파일 선택·드롭·썸네일
      model/                       Rust 선택 상태를 반영하는 Zustand 스토어
    library/
      components/                  시작 화면 문서함·개인 도구함·문서 메타데이터 기록
      lib/                         인증된 서버 API·응답 검사
      model/                       계정별 도구 목록과 로그아웃 정리
    pdf-editor/
      components/
        preview/                   편집 화면과 확대·축소
        pages/                     페이지 사이드바
        text/                      텍스트 선택과 인라인 입력
        stamps/                    워터마크 설정·미리보기와 서명 그리기
        graphics/                  이미지·도형 편집
        controls/                  편집 크기 조절
      lib/
        fonts/                     편집 글꼴 로딩·매칭·서식
        geometry/                  PDF 좌표 변환
        graphics/                  그래픽 변환·클립보드
        text/                      입력 레이아웃·선택 병합
        stamps/                    투명 PNG 생성·서명 여백 제거
    about/
      components/                  앱 정보·버전·개인정보 대화상자
      content/                     개인정보 처리방침 원문
      lib/                         릴리스 조회·업데이트 호출
  shared/
    desktop/                       파일 IPC·데스크톱 감지·종료 가드
    pdf/                           PDF 타입·IPC·공통 선택 계산
    ui/                            공통 버튼과 대화상자
    lib/                           공통 스타일 유틸리티
```

- `app`은 화면을 조합하고 `features`는 사용자 기능을 구현합니다. `shared`는 `app`이나 `features`를 가져오지 않습니다.
- 파일 선택 상태는 `features/file-input/model/file-store.ts`의 `useFileStore`가 관리합니다. PDF 편집 화면은 이 스토어의 선택 결과를 사용합니다.
- PDF IPC는 `shared/pdf/api.ts`, 직렬화 계약은 `types.ts`, 블록 선택 계산은 `selection.ts`에 둡니다. 타입만 필요한 코드는 `import type`을 사용합니다.
- 편집 화면은 `renderPage`, 파일·사이드바 미리보기는 `renderThumbnail`을 사용합니다. `thumbnail: true`인 요청만 텍스트 추출을 생략하며, 편집 화면은 최대 축소 시에도 텍스트·도형·문단 정보를 유지합니다. 렌더링 폭으로 썸네일 여부를 판단하지 않습니다.
- 편집 페이지는 줌과 독립적으로 최대 폭 1,600 px·높이 2,200 px의 비트맵과 편집 좌표를 준비합니다. 확대·축소는 `ZoomSurface`의 크기와 스크롤만 변경하고, Ctrl+휠·핀치는 마우스 아래의 문서 지점을 고정합니다. 비율 메뉴는 화면 중앙을 기준으로 사용합니다. 줌 변경은 PDF 재렌더링, 로딩 표시, 선택·입력 상태 초기화를 일으키지 않습니다.
- 같은 폴더의 파일은 상대 경로를, 다른 영역의 파일은 `@/` 경로를 사용합니다. TypeScript, Vite, Vitest 모두 `@/`를 `src/`로 해석합니다.
- `shared/lib/errors.ts`는 진단 메시지와 사용자 안내를 분리합니다. 알 수 없는 예외·네트워크·응답 형식 오류는 기능별 복구 안내로 바꾸고, 내부 분기에는 `errorDetail`을 사용합니다. 명시적으로 작성한 `UserFacingError`만 그대로 표시합니다. 조회는 일시 오류에 한 번만 재시도하며, 전송 실패 시 저장·삭제를 자동 재전송하지 않습니다. 처리 전에 인증이 거부된 401에 한해 토큰 갱신 후 한 번 재요청합니다. 새로고침 실패 시 이미 불러온 목록과 편집 입력은 유지합니다.
- 테스트는 검증 대상 옆의 `*.test.ts` 또는 `*.test.tsx`에 둡니다.

## Tauri 어댑터

```text
apps/desktop/src-tauri/src/
  main.rs                          실행 진입점
  runtime/mod.rs                   플러그인·상태·엔진 초기화와 명령 등록
  commands/
    files.rs                       파일 검사·선택 IPC와 DTO
    preview.rs                     렌더링·편집·글꼴 IPC와 DTO
    updates.rs                     업데이트 다운로드·검증·설치
```

Tauri 어댑터는 프론트엔드 요청을 엔진 호출로 변환합니다. 명령의 이름과 IPC 데이터 형식은 폴더 구조와 독립적입니다.

## PDF 엔진

```text
crates/pdf-core/src/
  lib.rs                           모듈 선언과 공개 API
  engine/                          클라이언트·프로토콜·워커·렌더링·공통 오류
  document/                        파일 검사·선택·페이지 작업·저장
  text/                            텍스트 추출·레이아웃 복원·정렬
  fonts/                           제공·설치 글꼴과 원본 글꼴 복원
  editing/
    action.rs                      편집 명령과 상태 계약
    history.rs                     트랜잭션·Undo/Redo
    dispatch.rs                    편집 명령 분배
    replace.rs                     객체·그룹 텍스트 교체
    block.rs                       문단 재배치
    flow/                          문단 확장·후속 객체 이동·줄바꿈
    graphics.rs                    이미지·도형 편집
    movement.rs                    객체 이동·크기 변경
    stamps.rs                      워터마크 교체·제거·기본 크기 서명 삽입
    verification.rs                편집 전후 보존 검사
  content_stream/                  PDF 원본 연산자 이동·텍스트 교체·간격 보존
  compat/                          기존 edit·render 공개 API
```

- PDFium과 문서 핸들은 `engine/worker.rs`의 워커가 소유합니다. 엔진은 Tauri에 의존하지 않습니다.
- 편집 연산은 후보 PDF를 생성하고 검증합니다. 문서와 이력의 교체는 `editing/history.rs`가 담당합니다.
- 엔진 내부는 실제 소유 영역의 모듈 경로를 사용합니다. `lib.rs`는 기존 소비자를 위해 `pdf_core::edit`, `render`, `error`, `selection`, `pages`, `layout`, `alignment` 경로를 재노출합니다.
- 단위 테스트는 모듈 내부에, 실제 PDFium 회귀 테스트와 예제는 기존 `tests/`, `examples/`에 둡니다.

## 서버 문서함과 도구함

로그인 요청은 `features/auth/lib/request-session.ts`에서 SDK 세션과 화면의 계정 식별자를 함께 확인합니다. SDK 메모리 세션이 없으면 현재 계정의 갱신 토큰으로 복원하고, API의 401 응답에는 갱신을 한 번 공유한 뒤 재요청합니다. 갱신 중 계정이 바뀌면 이전 계정 결과를 반영하지 않습니다. 일시적인 인증 연결 실패는 로그아웃으로 처리하지 않습니다. 개발 중에는 같은 Supabase SDK 인스턴스를 HMR 사이에 유지하고 구독을 정리합니다. 같은 계정의 토큰이 갱신되면 문서함·도구함과 실패한 문서 기록을 다시 확인합니다.

로컬 개발은 `pnpm dev:backend`로 `.env`의 Supabase 공개 설정을 읽어 `127.0.0.1:18081`에 서버를 실행합니다. 개발 DB는 `.cache/dev-backend/paperkit.sqlite3`에 별도로 생성됩니다. Vite 개발 화면은 `/api` 프록시로 로컬 서버를 사용하며, 배포 빌드는 `VITE_API_BASE_URL`을 사용합니다. 로컬 검증에 운영 서버 재배포나 SSH 접속은 필요하지 않습니다.

`apps/backend/src/library.rs`는 문서 메타데이터 등록·검색·즐겨찾기와 개인 도구 CRUD를 담당합니다. 모든 API는 인증된 사용자 식별자로 데이터를 제한합니다. `003_library.sql`은 즐겨찾기 컬럼과 도구 테이블을 추가하며, 서버 시작 시 기존 데이터베이스에 순서대로 적용됩니다. 이 기능을 사용하려면 새 서버 코드도 배포해야 합니다.

문서함은 로컬 PDF의 이름과 위치만 기록합니다. 도구함은 최대 50개의 이미지·문구·워터마크 문구·전자서명을 보관하며 종류별 필터를 클라이언트에서 적용합니다. 편집 화면에서 카드 자체를 누르면 해당 도구를 사용하고, 삭제 버튼은 별도 동작입니다. 이미지 업로드는 PNG로 정규화하고 긴 변을 1,200 px 이내로 줄입니다. 전자서명은 기존 `SignatureDialog`에서 그려 투명 PNG로 보관하고 재사용할 때 `addSignature`로 삽입합니다. 서버는 이미지와 서명 모두 최대 1 MB와 픽셀 수 제한을 검사합니다. `004_signature_tools.sql`은 기존 도구를 보존하며 서명 종류를 추가합니다. 문구는 최대 4,000자입니다. PDF 편집·렌더링은 기존 로컬 엔진에서 수행합니다.

## 검증 명령

저장소 루트에서 실행합니다.

```powershell
pnpm typecheck
pnpm test:web
pnpm build:web
pnpm format:check
cargo check --workspace --locked
cargo test --workspace --locked
pnpm test:pdfium
pnpm test:corpus
pnpm test:fonts
pnpm test:stamps
pnpm test:ensemble
```

PDFium 통합 검증에는 준비된 네이티브 리소스가 필요합니다. `pnpm setup:pdfium`, `pnpm setup:fonts`, `pnpm setup:engines`로 준비하며, PDFium 초기화가 충돌하지 않도록 corpus·fonts 테스트는 기존 스크립트가 테스트별 프로세스로 실행합니다. qpdf 교차 검증·복구와 로컬 OCR의 역할·제약은 [앙상블 엔진 문서](crates/pdf-core/ORCHESTRATION.md)에 정리했습니다.

서명 입력은 `signature_pad`를 사용합니다. 그린 서명과 텍스트·이미지 워터마크는 프론트엔드에서 투명 PNG로 만든 뒤 엔진에 전달합니다. `addWatermark`는 `page: null`이면 전체 페이지에 적용하며 한 트랜잭션으로 검증·반영합니다. `addSignature`는 현재 페이지 가운데의 144 × 72 pt 범위에 비율을 유지해 삽입합니다. 생성한 객체는 기존 이미지 편집 경로를 사용합니다.

워터마크의 텍스트·이미지 원본은 내용이 바뀔 때만 생성합니다. 투명도·크기·각도는 같은 미리보기 이미지에 CSS로 즉시 반영하고, 적용 시 마지막 설정을 PNG에 기록합니다. 초기화는 종류·텍스트·이미지 선택·색상·슬라이더·적용 범위를 모두 기본값으로 되돌립니다. 모달은 창 높이에 맞는 고정 영역을 사용하며 페이지 미리보기를 남은 공간에 맞춰 줄입니다.

종류를 이미지로 바꾸면 이전 텍스트 값과 미리보기 소스를 즉시 비우고 크기 80%·각도 0°를 사용합니다. 파일 선택 전의 기본 이미지는 미리보기 전용 SVG이며 PDF에 적용할 수 없습니다. 실제 파일을 선택해 읽기가 끝난 뒤에만 적용할 수 있고, 이전 비동기 텍스트 결과가 뒤늦게 도착해도 이미지 소스를 덮어쓰지 않습니다.

워터마크 이미지의 `Do` 연산자에는 `PaperkitWatermark` marked-content 표식을 기록합니다. 같은 범위에 다시 적용하면 기존 표식 객체를 교체하며, `removeWatermark`는 표식 객체만 제거합니다. 저장·재열기·이미지 이동 후에도 표식이 유지됩니다. 제거는 다른 텍스트의 내용·배치와 워터마크 영역 밖 렌더링을 검증한 뒤 한 번의 이력으로 반영합니다. 표식 없이 예전 버전에서 추가한 이미지는 자동 제거 대상으로 추측하지 않습니다. `PageText.watermarkPages`와 `watermarkObjects`로 사용 상태와 미리보기 배경에서 제외할 객체를 전달합니다.

공통 UI는 `shared/ui/`의 shadcn/Radix 구성요소를 사용합니다. Select·Switch·Slider·RadioGroup·Popover와 Button·Input·Textarea를 이 경로에서 교체할 수 있습니다. Dialog·AlertDialog·Select의 Radix 포커스 관리 버전은 함께 맞춰 모달 내부 포털의 포커스 충돌을 방지합니다. 초기화는 공통 확인창을 거치고, 워터마크·서명 모달은 닫힘 상태에서 퇴장 애니메이션이 끝날 때까지 소유 컴포넌트를 유지합니다.

앱 정보 컴포넌트는 네이티브 앱 시작 시 릴리즈를 확인합니다. 새 정식 버전이 있을 때만 i 버튼 아래 알림을 표시하며, 알림을 닫거나 버전 창에서 확인하면 해당 버전의 말풍선은 현재 화면 세션 동안 다시 표시하지 않습니다.
