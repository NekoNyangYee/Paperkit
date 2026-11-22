# Paperkit 서버의 자원 상한

기본 배포에서 API와 Caddy를 하나씩 실행하면 합산 상한은 CPU 0.25코어 상당, RAM 512 MiB다. CPU 값은 스케줄러가 허용하는 CPU 시간으로, 다른 서비스도 유휴 코어를 사용할 수 있다.

운영 장치는 Raspberry Pi 5 Model B Rev 1.1이다. 확인 당시 CPU 4코어, RAM 8,062 MiB 중 가용 6,973 MiB, 루트 디스크 227 GiB 중 가용 206 GiB였다. 같은 예산의 서비스 묶음 12개를 실행하면 CPU 3코어, RAM 6,144 MiB, 전용 데이터 디스크 최대 144 GiB를 배정한다. OS·공용 Docker 이미지·빌드 캐시는 별도의 여유를 사용한다. 컨테이너별 피크 부하는 아직 측정하지 않았다. 기존 `.env`에 명시한 상한은 Compose 기본값보다 우선한다.

| 서비스 | CPU 상한 | RAM 상한 | 조정할 환경 변수                               |
| ------ | -------: | -------: | ---------------------------------------------- |
| API    |     0.20 |  416 MiB | `PAPERKIT_API_CPUS`, `PAPERKIT_API_MEMORY`     |
| Caddy  |     0.05 |   96 MiB | `PAPERKIT_PROXY_CPUS`, `PAPERKIT_PROXY_MEMORY` |

두 서비스 모두 메모리와 메모리+스왑 한도를 같게 설정한다. Linux 호스트에서 메모리·스왑 제어를 지원하면 컨테이너가 추가 스왑을 사용할 수 없다. 각 서비스의 임시 디렉터리는 16 MiB tmpfs다. Docker 로그는 서비스마다 10m 파일 3개까지 회전한다. 이미지, 빌드 캐시, 배포 중 Rust 빌드는 호스트의 Docker 엔진을 사용하며 위 실행 상한과 별도로 공간과 연산 자원을 사용한다.

## DB와 백업을 합쳐 12 GiB로 제한하기

기본 Compose는 기존 `database`, `backups` 볼륨을 사용하며 용량 상한이 없다. Linux 운영 서버에서 아래 설정을 켜면 DB, SQLite WAL, 백업이 하나의 고정 크기 파일시스템을 공유한다. 실제 쓰기 한계는 그 파일시스템의 크기다. `PAPERKIT_STORAGE_MAX_GIB`는 시작 시 허용할 최대 크기를 검사하는 값이다.

1. Paperkit 전용 ext4 파티션 또는 고정 크기 논리 볼륨을 준비해 `/srv/paperkit-storage`에 마운트한다. 기본 예산은 12 GiB이며 서버 여유에 맞게 조정할 수 있다. 재부팅 시에도 Docker보다 먼저 마운트되도록 설정한다.
2. 아래 명령으로 마운트를 확인하고 서비스 계정 전용 디렉터리를 만든다.

   ```sh
   mountpoint -q /srv/paperkit-storage &&
     sudo install -d -m 0700 -o 10001 -g 10001 /srv/paperkit-storage/{data,backups}
   df -h /srv/paperkit-storage
   ```

3. 기존 운영 서버라면 아래 이관 절차를 먼저 수행한다. 새 설치라면 프로젝트의 `.env`에 다음 설정을 추가한다.

   ```dotenv
   COMPOSE_FILE=compose.yaml:deploy/compose.storage.yaml
   PAPERKIT_STORAGE_ROOT=/srv/paperkit-storage
   PAPERKIT_STORAGE_MAX_GIB=12
   ```

4. 새 설치에서만 빈 DB를 초기화한 뒤 배포한다.

   ```sh
   docker compose --env-file .env build backend
   docker compose --env-file .env run --rm --no-deps backend migrate
   bash deploy/deploy.sh
   ```

## 기존 서버 이관

배포 자동화와 외부 쓰기를 잠시 중지한다. 대상 디렉터리가 비어 있고 DB와 기존 백업이 모두 들어갈 공간이 있는지 확인한다. 아직 기존 볼륨 설정을 사용하는 상태에서 다음을 실행한다.

```sh
docker compose --env-file .env stop proxy
bash deploy/backup.sh
docker compose --env-file .env stop backend
container=$(docker compose --env-file .env ps --all --quiet backend)
sudo docker cp -a "$container:/data/." /srv/paperkit-storage/data/
sudo docker cp -a "$container:/backup/." /srv/paperkit-storage/backups/
```

복사한 DB와 백업의 파일 크기·체크섬을 원본과 대조한다. SQLite의 WAL 파일이 남았다면 DB와 함께 복사되어야 한다. `.env`에 위 세 줄을 설정하고 복사본 검사를 거쳐 배포한다.

```sh
docker compose --env-file .env build backend
docker compose --env-file .env run --rm --no-deps backend --check-storage
docker compose --env-file .env run --rm --no-deps backend migrate
bash deploy/deploy.sh
```

새 DB에 쓰기를 허용하기 전에는 서비스를 멈추고 `.env`에서 `COMPOSE_FILE` 설정을 제거한 뒤 기존 볼륨으로 재배포할 수 있다. 새 DB에 쓰기가 발생한 이후에는 최신 데이터를 역이관해야 한다.

## 용량 산정과 확인

- 복구 스냅샷은 문서당 PDF 최대 32 MiB를 DB에 저장할 수 있다. 도구함의 이미지·서명은 각각 최대 1 MiB이며 base64로 저장된다. 계정당 도구 50개를 모두 이미지로 채우면 메타데이터와 SQLite 오버헤드 전 약 66.7 MiB다.
- DB 본체, WAL, 보관할 백업과 다음 백업 한 회를 위한 여유를 함께 계산한다. 전용 디스크가 차면 Paperkit의 쓰기와 백업이 실패할 수 있다.
- 전용 저장소 모드에서는 검증된 백업을 `/srv/paperkit-storage/backups`에 한 번 저장한다. 기본 볼륨 모드는 종전처럼 프로젝트의 `backups/`에도 복사한다. 과거 사본은 그대로 남고 자동 삭제는 없다. 장치 장애 복구용 사본은 별도 장치에 보관한다.

```sh
docker stats --no-stream $(docker compose --env-file .env ps -q)
docker compose --env-file .env exec -T backend sh -c 'df -h /data /backup && du -sh /data /backup'
docker system df
```

Docker에서 제공하는 각 설정의 의미는 [Compose 서비스 자원 제한](https://docs.docker.com/reference/compose-file/services/#mem_limit)과 [볼륨 문서](https://docs.docker.com/engine/storage/volumes/)에서 확인할 수 있다.
