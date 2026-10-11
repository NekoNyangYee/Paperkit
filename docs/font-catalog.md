# Paperkit 글꼴 목록

2026-10-10 기준. 실제 배포 목록과 다운로드 URL/고정 커밋/SHA-256/라이선스 해시는 `scripts/fonts-manifest.json`이 기준이다. `pnpm setup:fonts`로 동일 파일을 설치하며 라이선스도 앱 리소스에 동봉한다.

## 기본 제공: 11개 글꼴 계열, 27개 파일

| 계열             | 제공 스타일                                 |
| ---------------- | ------------------------------------------- |
| Pretendard       | Regular, Medium, SemiBold, Bold             |
| Noto Sans KR     | Thin (기존 가변 폰트의 기본 인스턴스)       |
| Noto Serif KR    | ExtraLight (기존 가변 폰트의 기본 인스턴스) |
| 나눔고딕         | Regular, Bold, ExtraBold                    |
| 나눔명조         | Regular, Bold                               |
| 나눔고딕코딩     | Regular, Bold                               |
| 고운바탕         | Regular, Bold                               |
| 고운돋움         | Regular                                     |
| IBM Plex Sans KR | Regular, Medium, Bold                       |
| Carlito          | Regular, Bold, Italic, BoldItalic — 영문용  |
| Caladea          | Regular, Bold, Italic, BoldItalic — 영문용  |

27개 TTF 합계는 97,354,860 bytes(약 93 MiB, 압축 전)이다. 다운로드한 파일을 변형하지 않고 원본 라이선스와 함께 포함한다. Carlito/Caladea는 한글 입력을 지원한다고 표시하지 않으며, 없는 글자는 기존대로 오류를 반환하고 원본을 보존한다.

나눔명조 ExtraBold는 실제 PDFium 검사에서 `한글 문서 확인 English 123`의 공백이 사라지는 현상이 재현되어 배포 목록에서 제외했다.

## 설치된 글꼴 연결

한컴바탕(`Haansoft Batang`, 공백 없는 PostScript 이름도 동일하게 검색)을 설치 글꼴 목록에 추가했다. 함초롬바탕과 별도 항목이며, PC에 설치된 파일을 사용한다.

드롭다운의 `이 PC의 글꼴`에는 설치된 항목만 표시한다. 대상은 맑은 고딕, 바탕/바탕체, 돋움/돋움체, 굴림/굴림체, 궁서/궁서체, 함초롬바탕/함초롬돋움, Arial, Times New Roman, Calibri, Cambria, Aptos 및 목록에 정의한 굵은 스타일이다. 일부 Office/한컴 전용 폴더에만 있는 글꼴은 Windows 글꼴 폴더에 설치되지 않았다면 검색되지 않을 수 있다.

원본 PDF에서 글꼴을 재사용할 때는 PDF 내장 데이터가 우선이다. 같은 글꼴이 필요하면 앱 기본 제공 글꼴과 Windows 설치 글꼴에서 정확한 face 이름을 찾는다. Regular와 Bold 또는 서로 다른 계열을 자동 대체하지 않는다. 새 글꼴 설치 후 앱을 다시 시작해야 한다.

Windows/Office 글꼴 파일은 앱 리소스에 복사하지 않는다. [Microsoft 재배포 안내](https://learn.microsoft.com/en-us/typography/fonts/font-faq)는 문서 임베딩 허용과 앱에 글꼴을 재배포하는 권한을 구분한다. 한컴 글꼴도 [한컴 안내](https://www.hancom.com/support/faqCenter/faq/detail/2462)에 따라 글꼴별 권리자가 다르므로 이번에는 설치된 글꼴 연결만 제공한다.

기본 제공 글꼴은 공식 [Google Fonts 저장소](https://github.com/google/fonts) 및 [Pretendard 저장소](https://github.com/orioncactus/pretendard)의 OFL 배포 파일을 사용한다. 글꼴별 정확한 저작권 문구와 라이선스는 앱의 `resources/fonts/*-LICENSE.txt`에 보관한다.

## 검증

`pnpm test:fonts`는 기본 제공 글꼴별 교체, 잘못된 문자 거부, Undo/Redo, 저장 및 재열기 일치를 검사한다. 한글 지원 글꼴에는 한글 수정 검사도 적용한다. 영문용 글꼴은 한글 미지원 검사를 거친 뒤 영문 검사로 검증한다. 설치 글꼴 및 기본 제공 파일에서 동일 face를 찾는 경로도 별도로 검사한다.
