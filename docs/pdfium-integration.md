# PDFium 연동 및 배포 검토

현재 구현: `pdfium-render =0.9.4` + `pdfium_7881` + Windows x64 동적 라이브러리.
`pnpm setup:pdfium`으로 SHA-256 검증 후 DLL/라이선스를 준비하며, 실제 DLL 로딩과 2페이지 렌더링 테스트를 통과했다.
문서와 엔진은 전용 worker의 로컬 변수로 수명을 관리한다. 아래는 초기 검토 기록이며 최신 구현 범위와 제한은 README의 5단계를 참조한다.

2026-10-09 검토. 아래 내용은 다음 단계의 설계안이며, PDFium 연동/네이티브 실행 검증은 아직 하지 않았다.

## 의존성 후보

문서로 확인한 `pdfium-render` 버전은 0.9.4다. 다음 단계에서 `pdf-core`에만 추가할 후보:

```toml
[dependencies]
pdfium-render = { version = "=0.9.4", default-features = false, features = ["pdfium_7881", "thread_safe"] }
```

0.9.4의 `pdfium_latest`는 `pdfium_7881`에 대응한다. 릴리스마다 움직이는 별칭 대신 명시적 ABI feature와 검증된 바이너리를 함께 고정한다.
이미지 크레이트는 지금 추가하지 않는다. 첫 렌더링 구현에서 비트맵 전달/PNG 인코딩 방식을 정한 뒤 `image_025` 등의 필요성을 판단한다.
버전과 feature의 존재는 확인했지만 이 조합의 로컬 컴파일과 ABI 적합성은 검증 전이다.
[crate feature 문서](https://docs.rs/crate/pdfium-render/0.9.4/features)

`pdfium-render`는 네이티브 PDFium 자체를 제공하지 않는다. `Pdfium::bind_to_library()`로 라이브러리 파일을 명시해 로딩하는 동적 로딩 방식을 우선 채택한다.
`static` 방식은 빌드/배포 복잡도가 커지는 만큼 초기에는 사용하지 않는다.
[pdfium-render 로딩 문서](https://github.com/ajrcarey/pdfium-render#dynamic-linking)

## 네이티브 배포 정책

첫 지원 대상은 현재 개발 환경에 맞춘 Windows x64다.

| 대상            | 배포 파일                 | 상태                      |
| --------------- | ------------------------- | ------------------------- |
| Windows x64     | `pdfium.dll`              | 우선 검증                 |
| Windows ARM64   | `pdfium.dll` (ARM64 빌드) | 추후 별도 검증            |
| macOS arm64/x64 | `libpdfium.dylib`         | 추후 서명/배포 검증       |
| Linux x64       | `libpdfium.so`            | 추후 glibc/배포 환경 검증 |

바이너리 공급원 후보는 `pdfium-render`에서도 안내하는 [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries)다.
이 프로젝트는 Google 공식 배포가 아닌 별도 배포 프로젝트이며 동적 라이브러리를 제공한다.
실제 도입 시 다음 절차를 구현한다.

1. 호환 release tag, 대상 아키텍처, 다운로드 URL, SHA-256을 버전 관리하는 manifest에 기록한다. `latest` URL로 자동 갱신하지 않는다.
2. 빌드 준비 단계에서 다운로드하고 해시를 검사한다. 누락/불일치하면 패키징을 중단한다. 앱 실행 중에는 다운로드하지 않는다.
3. 대상 플랫폼 파일과 해당 배포물의 라이선스/NOTICE를 설치 패키지에 함께 포함한다.
4. Tauri `bundle.resources`로 대상 라이브러리만 포함하고, Rust에서 `app.path().resolve(..., BaseDirectory::Resource)`로 절대 경로를 얻는다.
5. 경로를 `pdf-core`에 전달해 로딩한다. `pdf-core`는 Tauri 경로나 `AppHandle`을 알지 않는다.
6. 개발 모드에만 명시적 라이브러리 경로 설정을 허용한다. 작업 디렉터리나 시스템 PATH에서 임의로 라이브러리를 찾지 않는다.
7. DLL 누락, 아키텍처 불일치, 심볼 로딩 오류는 직렬화 가능한 오류 코드와 사용자 메시지로 전달하고 편집을 비활성화한다.

macOS는 번들 안 dylib의 서명과 notarization, Linux는 최소 지원 런타임, Windows는 배포물의 실제 DLL 의존성을 각각 검증한다.
현재는 검증되지 않은 바이너리 다운로드나 존재하지 않는 resource 설정을 추가하지 않았다.
[Tauri resource 패키징과 경로 API](https://v2.tauri.app/develop/resources/)

## Rust 소유권 및 IPC 경계

문서와 PDFium 핸들의 수명은 Rust가 소유한다. UI에는 문자열 문서 ID, 페이지 번호, 객체 ID, 문서 revision, 좌표 및 속성 데이터만 전달한다.
페이지/객체 인덱스는 변경이나 재로드 뒤 영구 ID로 취급하지 않는다. 수정 성공 후 revision을 증가시키고 페이지 객체 목록을 다시 추출하며 이전 선택 ID를 무효화한다.

PDFium을 초기화하고 사용하는 단일 worker가 문서 명령을 순서대로 처리하는 방안을 우선 검증한다.
Tauri managed state에는 worker의 송신 핸들을 두고 UI 스레드에서 렌더링을 수행하지 않는다.
`thread_safe` feature만으로 문서 수명이나 모든 타입의 `Send/Sync`가 해결된다고 가정하지 않는다.
`PdfDocument`의 바인딩 수명, 페이지 borrow, 종료 시 문서→엔진 해제 순서를 확인한 뒤 구현한다.
자기참조 구조를 억지로 구성하거나 `unsafe impl Send`로 우회하지 않는다.

`document.rs`, `text.rs`, `render.rs`, `save.rs`는 각 기능을 구현할 때 생성한다.
파일 선택 대화상자는 그 단계에서 Tauri dialog 플러그인을 추가하고, PDF I/O는 Rust에서 수행한다.

## 기존 텍스트 수정의 범위

PDFium은 `FPDFText_SetText`로 기존 텍스트 객체의 문자열을 바꿀 수 있다.
페이지 변경은 저장/재로드 전에 `FPDFPage_GenerateContent`로 반영해야 한다.
[PDFium 공식 편집 헤더](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_edit.h)

Rust wrapper에도 `PdfPageTextObject::set_text()`가 존재한다. 다음 단계에서는 0.9.4에 고정된 실제 소스와 자동 콘텐츠 재생성 정책을 확인하고 샘플로 저장 결과를 검증한다.
API가 있다는 사실만으로 모든 기존 PDF 편집이 가능하다고 판단하지 않는다.
[텍스트 객체 API](https://docs.rs/pdfium-render/latest/pdfium_render/prelude/struct.PdfPageTextObject.html)

- 최초에는 페이지의 지원 가능한 개별 텍스트 객체만 편집한다. Form XObject 내부, 복잡한 변환/클리핑, 세로쓰기 등 검증되지 않은 구조는 명시적으로 거절한다.
- 기존 폰트/서브셋에서 대체 문자열의 모든 글리프를 확인한다. 지원 여부를 입증하지 못하면 편집하지 않는다. 임의의 폰트로 조용히 교체하지 않는다.
- 원래 폰트, 크기, 색상, 행렬, 위치를 보존한다. 변경 후 경계와 주변 충돌을 검사하고 허용 영역을 넘으면 거절한다. 글자 수만으로 너비를 판단하지 않는다.
- 좌표 변환은 PDF 포인트, CropBox, 회전, 화면 CSS 픽셀, 장치 픽셀 비율, zoom을 분리한다. 클릭 선택과 렌더링에 동일한 변환을 사용한다.
- 변경 전 데이터를 보관하고 글리프/레이아웃/콘텐츠 재생성 실패 시 문서가 반쯤 수정된 상태로 남지 않도록 트랜잭션 경계를 둔다.

## 저장 및 검증 기준

원본과 동일 파일(대소문자/심볼릭 링크/하드링크 포함)을 대상으로 저장하지 않는다.
선택한 새 경로와 같은 디렉터리의 임시 파일에 저장한 뒤 다시 열고 페이지 수, 수정 텍스트, 객체 속성과 렌더링 결과를 검증한다.
성공한 파일만 최종 경로로 확정한다. 기존 대상 파일 덮어쓰기는 명시적 사용자 선택이 필요하며 실패 시 원본과 기존 출력 파일을 보존한다.

다음 단계의 테스트에는 다음이 필요하다.

- 지원 폰트의 짧은 텍스트 수정 후 저장·재열기·렌더링 비교
- 한글/서브셋 누락 글리프, 길이 초과, 지원 불가능한 객체의 거절과 롤백
- 회전, CropBox, zoom, DPR에 대한 선택 좌표 검증
- 수정 후 이전 revision/객체 ID 거절
- 암호화/손상/이미지 전용 PDF, 라이브러리 누락/불일치에 대한 오류 처리
- 저장 권한 실패, 경로 충돌, 원본과 같은 파일 지정 시 원본 해시 보존

OCR, 문단 재배치, 자동 폰트 대체, 클라우드 동기화는 이번 MVP에 포함하지 않는다.
