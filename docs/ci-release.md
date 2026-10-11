# Windows CI / GitHub Release

대상 저장소: `NekoNyangYee/pdf-editor`. 현재 지원하는 네이티브 배포 대상은 Windows x64다.

## 실행 흐름

- PR, main/master push, 수동 실행: 버전 일치 → PDFium·글꼴 SHA-256 검증 → 포맷·프론트·Rust 테스트 → 네이티브 편집 테스트 → NSIS 설치 파일 빌드 → Actions artifact 보관(14일).
- `vX.Y.Z` 태그 push: 위 검사를 모두 통과한 설치 파일과 SHA256SUMS.txt를 GitHub Release에 첨부하고 정식 게시한다. 게시 전 임시 draft 단계가 있다. 같은 태그의 기존 릴리즈는 덮어쓰지 않는다.
- PR에는 쓰기 권한이 없고, 릴리즈 작업만 `contents: write`를 사용한다. 별도 PAT 없이 GitHub의 `GITHUB_TOKEN`을 사용한다.
- 앱 버전 확인 창은 이 저장소의 최신 **정식** 릴리즈를 조회한다. 앱 자동 설치/업데이트는 포함하지 않는다.

## 릴리즈 절차

저장소를 체크아웃한 작업 폴더에서 의존성을 설치한 뒤 실행한다.

```powershell
node scripts/version.mjs 0.1.1
pnpm format:check
git add package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json Cargo.toml Cargo.lock
git commit -m "Release 0.1.1"
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

먼저 이번 변경 파일과 `.github/workflows/windows.yml`을 저장소에 커밋해야 한다. `main` 대신 실제 기본 브랜치 이름을 사용한다. 버전 스크립트는 JS 패키지 2개·Tauri 설정·Cargo workspace·Cargo.lock 버전을 함께 갱신한다. CI는 태그와 앱 버전이 다르면 배포를 중단한다. 최초 현재 버전 릴리즈는 버전 변경 없이 `v0.1.0` 태그를 사용할 수 있다.

GitHub Settings → Actions에서 워크플로 실행이 허용되어 있어야 한다. 조직 정책이 쓰기 권한을 막으면 릴리즈 작업은 실패하므로 저장소 관리자가 정책을 확인해야 한다.

실패 후 재실행할 때 이미 생성된 draft가 있으면 먼저 그 draft와 설치 파일을 확인한다. 워크플로는 기존 릴리즈를 자동 삭제하거나 덮어쓰지 않는다. 코드 서명 인증서가 구성되지 않았으므로 현재 설치 파일은 서명되지 않는다.

개인 PDF와 특정 PC에 설치된 글꼴이 필요한 테스트는 CI에 넣지 않는다. 합성 PDF·번들 글꼴 기반의 편집/정렬/저장/원본 보존 테스트를 실행한다. 로컬 설치 파일 빌드 성공과 GitHub 호스팅 러너에서 워크플로가 성공한 것은 별개다.
