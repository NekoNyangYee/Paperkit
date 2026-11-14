# 라즈베리파이 저장 공간

2026-11-14 저장소 설정 기준. 실제 서버의 실행 이미지 크기·볼륨 사용량을 측정한 수치는 아니다.

| 대상               | 현재 설정                                             |
| ------------------ | ----------------------------------------------------- |
| 백엔드             | linux/arm64, 메모리 768 MiB, CPU 2                    |
| Caddy              | linux/arm64, 메모리 128 MiB                           |
| DB                 | `database` named volume → `/data`; 디스크 quota 없음  |
| 백업               | `backups` named volume → `/backup`; 디스크 quota 없음 |
| 임시 파일          | 컨테이너별 tmpfs 16 MiB                               |
| 로그               | 서비스별 10 MB × 3개 회전                             |
| 이미지 파일 시스템 | 용량 상한 설정 없음, 런타임 read-only                 |

`mem_limit`은 RAM 제한이다. 이미지 크기나 볼륨 디스크 제한이 아니다. named volume은 호스트 디스크를 사용하며 현재 compose에는 별도 크기/파일 시스템 quota 설정이 없다.

## 용량 산정 시 포함할 데이터

- 문서함 목록은 원본 PDF의 경로·이름 등 메타데이터를 기록한다.
- 복구 스냅샷 API는 문서당 PDF 최대 32 MiB를 DB에 저장할 수 있다. 목록만으로 총 DB 크기를 계산하면 안 된다.
- 도구함은 계정당 50개, 이미지·서명 원본은 각각 최대 1 MiB다. DB에 base64로 저장하므로 이미지 도구를 모두 채우면 계정당 약 66.7 MiB에 메타데이터·SQLite 오버헤드가 더해진다.
- WAL, SQLite 작업 공간과 백업을 위한 여유를 별도로 둔다.
- `deploy/backup.sh`는 검증한 DB 백업을 `/backup`과 프로젝트의 `backups/`에 각각 저장한다. 자동 보존 개수/기간 제한은 없다. 둘이 같은 디스크에 있으면 백업 한 회당 DB 크기의 약 두 배가 추가된다.
- Docker 빌드 캐시와 이전 이미지도 볼륨과 별도로 디스크를 사용한다. PDFium·OCR·편집 글꼴은 데스크톱 리소스이며 서버 Dockerfile에서는 빌드하지 않는다.

총 사용자 수와 복구 스냅샷 문서 수를 정한 뒤 `DB 예상량 + WAL/작업 여유 + 보관할 백업 + 이미지/빌드 캐시 + 운영 여유`로 산정한다. 운영 데이터가 있는 볼륨의 경로나 driver를 바로 바꾸지 않는다. 새 파티션/파일 시스템에 quota를 설정하려면 기존 데이터를 백업·이관하고 재열기 검증한 뒤 mount를 전환한다.

## 서버에서 실제 크기 확인

프로젝트 폴더에서 읽기 전용으로 실행한다.

```sh
docker compose images
docker compose exec -T backend sh -c 'du -sh /data /backup'
du -sh backups
docker system df
df -h
```

참고: [Docker volumes](https://docs.docker.com/engine/storage/volumes/), [Compose mem_limit](https://docs.docker.com/reference/compose-file/services/#mem_limit).
