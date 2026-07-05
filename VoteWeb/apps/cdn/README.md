# Creeper CDN

Minecraft 리소스팩을 업로드/다운로드하기 위한 간단한 CDN 서버입니다. API 업로드, 다운로드 속도 제한, 기본적인 레이트 리밋, Nginx 리버스 프록시 연동을 지원합니다.

## 요구 사항

- Node.js 18 이상
- npm

## 설치 및 실행

```bash
npm install
cp .env.example .env   # 환경 변수 설정
npm start
```

`.env` 파일에서 포트, 공개 URL, 업로드 API 키 등을 원하는 값으로 변경합니다. `UPLOAD_API_KEY`를 설정하지 않으면 업로드가 비활성화됩니다.

## 디렉터리 구조

- `src/server.js` – Express 기반 메인 서버
- `storage/` – 업로드된 파일이 저장되는 루트
- 기본 구조는 `storage/<namespace>/<version>/<filename>` 이지만, `version` 을 생략하면 `storage/<namespace>/<filename>` 에 저장됩니다. 모든 파일은 내용 기반 SHA-256 해시의 앞 `HASH_FILENAME_LENGTH`(기본 32)자를 이용한 파일명(확장자는 유지)으로 저장되며, 원본 파일명·전체 해시·업로드 시각은 SQLite 메타데이터 DB에 기록됩니다. `namespace` 는 생략 시 `default`, `version` 은 생략 시 버전 없는 모드로 저장되며 `latest` 경로는 과거 호환용으로 계속 다운로드에 사용할 수 있습니다.

## 환경 변수

| 변수 | 설명 | 기본값 |
| --- | --- | --- |
| `PORT` | 서버 리스닝 포트 | `9000` |
| `PUBLIC_BASE_URL` | 업로드 성공 시 응답에 포함되는 CDN 기본 URL | `http://localhost:9000` |
| `STORAGE_ROOT` | 로컬 저장소 경로 | `storage` |
| `TRUST_PROXY` | Express `trust proxy` 설정 값 | `loopback` |
| `UPLOAD_API_KEY` | 업로드 인증용 API 키 (미설정 시 업로드 비활성화) | 환경에서 설정 필요 |
| `ADMIN_API_KEY` | 다운로드 통계 API/패널 접근 키 (기본은 `UPLOAD_API_KEY`) | 환경에서 설정 필요 |
| `MAX_FILE_SIZE_MB` | 업로드 허용 최대 용량(MB) | `512` |
| `GENERAL_RATE_LIMIT_WINDOW_MS` | 일반 요청 레이트 리밋 윈도(밀리초) | `900000` (15분) |
| `GENERAL_RATE_LIMIT_MAX` | 일반 요청 허용 횟수 | `500` |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` | 업로드 레이트 리밋 윈도(밀리초) | `3600000` (1시간) |
| `UPLOAD_RATE_LIMIT_MAX` | 업로드 허용 횟수 (0이면 비활성화) | `0` |
| `DOWNLOAD_SPEED_LIMIT_KBPS` | 다운로드 속도 제한 (KB/s, 0이면 무제한) | `12207` (~100 Mbps) |
| `CACHE_MAX_AGE_SECONDS` | CDN 캐시 응답 헤더 `max-age` | `604800` (7일) |
| `METRICS_FILE` | 다운로드 통계 JSON 저장 경로 | `data/metrics.json` |
| `SQLITE_DB_FILE` | 업로드 메타데이터(SQLite) 저장 경로 | `data/creeper.db` |
| `HASH_FILENAME_LENGTH` | 저장 파일명에 사용할 해시 접두 길이(문자, 짝수) | `32` |
| `STATIC_ROOT` | 정적 자산(예: favicon) 경로 | `public` |

## API

> 상세한 엔드포인트 스펙과 예시는 `docs/API.md` 를 참고하세요.

### 업로드 – `POST /api/upload`

- **헤더**: `Content-Type: multipart/form-data`, `X-API-Key: <UPLOAD_API_KEY>`
- **필드**
  - `file` (필수): 업로드할 리소스팩/이미지/기타 파일
  - `namespace` (선택): 콘텐츠 그룹 (영문/숫자/._-) — 반환 URL은 `https://cdn.creeper.wiki/<namespace>/<version>/<filename>` 형태입니다.
  - `version` (선택): 버전 태그 (영문/숫자/._-). 생략하면 파일이 네임스페이스 루트(`storage/<namespace>/<filename>`)에 저장되고, 응답에는 버전 없는 기본 URL(`urlLatest`)이 함께 제공됩니다. 과거 호환을 위해 `/namespace/latest/<filename>` 경로도 계속 동작합니다.
- 업로드가 완료되면 서버는 파일 콘텐츠의 SHA-256 해시를 계산해 앞 `HASH_FILENAME_LENGTH`(기본 32)자를 사용한 최종 파일명(`<hash-prefix>.<확장자>`)으로 치환합니다. 응답에는 전체 `hash`, `originalFilename`, `uploadedAt`, 필요 시 `urlVersioned`(버전 없는 업로드 시) 필드가 포함됩니다.
- 기본 설정에서는 업로드 레이트 리밋이 비활성화되어 있으며, API 키를 가진 관리자만 업로드할 수 있습니다.

요청 예시:

```bash
curl -X POST "https://cdn.creeper.wiki/api/upload" \
  -H "X-API-Key: <YOUR_API_KEY>" \
  -F "file=@MyPack.zip" \
  -F "namespace=creeper" \
  -F "version=1.20"
```

파이썬으로 업로드하려면 `examples/upload_example.py`를 사용할 수 있습니다.

```bash
pip install requests
python3 examples/upload_example.py \
  --api-key <YOUR_API_KEY> \
  --file MyPack.zip \
  --namespace creeper \
  [--version 1.20]
```

> `--version` 옵션을 생략하면 파일이 네임스페이스 루트에 저장되며 응답의 `version` 필드는 `null` 로 내려갑니다.
> 기본 다운로드 경로는 `https://cdn.creeper.wiki/<namespace>/<filename>` 이며, 호환을 위해 `latest` 별칭도 계속 제공됩니다. 저장 파일명은 해시 기반으로 치환되므로 응답의 `filename`/`hash` 필드를 참고해 주세요.

응답은 업로드된 파일의 다운로드 URL과 메타데이터(`hash`, `originalFilename`, `uploadedAt` 등)를 JSON 으로 반환합니다.

### 다운로드 – `GET /:namespace/:version?/:filename`

- 예: `GET https://cdn.creeper.wiki/creeper/1.20/MyPack.zip` 또는 버전 없이 `GET https://cdn.creeper.wiki/creeper/MyPack.zip`
- 파일 종류에 상관없이 `https://cdn.creeper.wiki/<namespace>/<version>/<filename>` 형태로 접근하며, 버전을 생략하면 서버가 먼저 네임스페이스 루트(`storage/<namespace>/<filename>`)를 확인하고 없을 경우 과거 호환을 위해 `latest` 경로를 조회합니다. 실제 파일명은 SHA-256 해시 앞 `HASH_FILENAME_LENGTH`자 기반으로 치환되므로, 응답/관리자 페이지에서 확인한 이름을 그대로 사용해야 합니다.
- `Range` 헤더를 지원하여 부분 다운로드가 가능합니다.
- 헤더: `Cache-Control`, `ETag`, `Last-Modified`, `Accept-Ranges` 등을 포함합니다.
- `HEAD` 메서드도 지원합니다.

## 관리자 API & 패널

- `GET /api/admin/metrics/downloads` : JSON 형태로 전체/파일별 다운로드 수와 전송량을 반환합니다. 헤더 `X-API-Key` 혹은 쿼리 파라미터 `token`/`apiKey` 에 `ADMIN_API_KEY` 값을 전달해야 합니다.
- `GET /admin/downloads` : 기존 경로는 `/admin/files` 로 리다이렉트하며 동일한 통합 대시보드를 표시합니다.
- `GET /api/admin/files` : 업로드된 파일을 JSON으로 나열합니다. `namespace`, `version` 쿼리로 탐색할 수 있으며, 버전 없이 호출하면 네임스페이스 목록이 반환됩니다. `version=__noversion__` 를 지정하면 해당 네임스페이스의 버전 없는 파일 목록을 직접 확인할 수 있습니다. 각 항목에는 `hash`, `originalFilename`, `uploadedAt` 이 포함됩니다. 추가로 `file=<stored_filename>` 쿼리를 전달하면 해당 파일의 최근 다운로드 시도(`downloadLogs`)도 함께 반환됩니다.
- `POST /api/admin/files/delete` / `DELETE /api/admin/files` : JSON body(또는 DELETE 쿼리스트링)에 `namespace`, `version`(선택, 버전 없는 경우 `"__noversion__"`), `filename` 을 전달하면 해당 파일 및 관련 메타데이터/로그가 삭제됩니다.
- `GET /admin/files` : 파일 브라우저 HTML 페이지. 네임스페이스 → 버전 → 파일 순으로 조회할 수 있고, 각 파일의 다운로드 수/전송량/최근 다운로드 시각과 함께 해시·원본 파일명도 표시됩니다. 네임스페이스 화면에서는 버전 없는 파일 테이블도 즉시 확인할 수 있으며 `version=__noversion__` 쿼리로 전용 화면에 접근할 수 있습니다. 각 파일 행의 `View logs` 링크를 클릭하면 해당 파일의 다운로드 시도 내역(IP, 전송량, User-Agent 등)이 바로 표시되며, `Delete` 버튼으로 즉시 삭제할 수 있습니다.
- 통계와 파일 메타데이터는 기본적으로 `data/metrics.json` 과 로컬 디렉터리 구조를 기반으로 하며, 서버가 종료될 때까지 주기적으로 디스크에 반영됩니다.

## Nginx 리버스 프록시 예시

도메인 `cdn.creeper.wiki` 에서 Node 서버(`127.0.0.1:9000`)를 프록시하는 기본 설정입니다. IP 중복 트래픽 제어를 위해 Nginx 레벨에서의 `limit_req` 블록도 예시로 포함했습니다.

```nginx
upstream creeper_cdn {
    server 127.0.0.1:9000;
    keepalive 32;
}

map $request_uri $cdn_cache_control {
    default "public, max-age=600";
    ~^/[^/]+/[^/]+/ "public, max-age=604800, immutable";
}

limit_req_zone $binary_remote_addr zone=cdn_limit:10m rate=30r/s;

server {
    listen 80;
    listen 443 ssl http2;
    server_name cdn.creeper.wiki;

    # SSL 설정 (예: Certbot) 추가

    add_header X-Served-By Creeper-CDN always;
    add_header Cache-Control $cdn_cache_control always;

    location / {
        limit_req zone=cdn_limit burst=100 nodelay;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://creeper_cdn;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    location = /healthz {
        proxy_pass http://creeper_cdn;
        proxy_set_header Connection "";
    }

    # 정적 파일에 대한 캐시 재검증 옵션 (선택)
    location ~* \.(zip|rar|7z|png|jpe?g|webp|gif)$ {
        expires 7d;
        proxy_pass http://creeper_cdn;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **TIP**: 프록시 뒤에 서버를 둘 경우 `.env` 의 `TRUST_PROXY` 값을 `1` 또는 `ip`/`loopback` 으로 올바르게 설정해야 클라이언트 IP 기반 레이트 리밋이 정상 동작합니다.

## 추가 고려 사항

- 업로드 시 `namespace`, `version` 값은 서버에서 소문자로 정규화됩니다. `namespace` 를 `packs`, `images`, `maps` 등으로 활용하면 같은 서버에서 다양한 자산을 분리할 수 있습니다.
- 대용량 파일을 업로드할 경우 `MAX_FILE_SIZE_MB`와 OS 수준의 업로드 제한(Nginx `client_max_body_size`)을 함께 늘려야 합니다.
- 장기적으로는 S3 호환 스토리지를 연결하거나, 다중 서버 환경에서 `STORAGE_ROOT`를 공유 스토리지(NFS 등)로 지정하면 확장성이 좋아집니다.
- `DOWNLOAD_SPEED_LIMIT_KBPS` 값은 기본 12207으로 설정되어 있으며, 이는 사용자당 약 100 Mbps 전송 속도에 해당합니다. 필요 시 환경 변수로 조정하세요.
- 업로드 메타데이터는 SQLite (`SQLITE_DB_FILE`)에 저장되며, 파일 해시·원본 파일명·업로드 시각 등을 추적합니다.
- 모든 다운로드 요청은 SQLite에 IP·User-Agent·전송 바이트·타임스탬프가 기록되며 `/admin/files` 버전 상세 화면에서 최근 기록을 확인할 수 있습니다.

## PM2 운영 가이드

```bash
# pm2 설치 (전역)
npm install --global pm2

# .env 로 설정된 환경 변수를 사용해 앱 실행
pm2 start npm --name creeper-cdn -- start

# 상태 확인 / 재시작 / 중지 / 로그
pm2 status creeper-cdn
pm2 restart creeper-cdn
pm2 stop creeper-cdn
pm2 logs creeper-cdn

# 부팅 시 자동 실행 (선택)
pm2 save
```

## 개발 메모

- Express 5, `multer`로 파일 업로드 처리
- `express-rate-limit`로 기본/업로드 레이트 제한
- `stream-throttle`로 다운로드 스트리밍 속도 제한
- `mime-types`로 적절한 `Content-Type` 헤더 설정
- 다운로드 라우트는 `Range` 헤더를 처리하여 부분 전송을 지원합니다.
