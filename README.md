# Overleaf Desktop

자체 호스팅 Overleaf(Community Edition) 서버에 접속하는 Electron 데스크탑 클라이언트.
컴파일과 프로젝트 저장은 모두 서버에서 이루어지며, 같은 서버를 웹 브라우저로도 그대로 쓸 수 있다.

## 실행

    npm install
    npm start                                     # 첫 실행 시 서버 주소 입력
    npm start -- --server=http://192.168.50.108   # 주소를 직접 지정 (OVERLEAF_URL 환경변수도 가능)

서버 주소와 창 위치는 사용자 데이터 폴더의 `config.json`에 저장된다
(리눅스 `~/.config/Overleaf Desktop/`, 윈도우 `%APPDATA%\Overleaf Desktop\`).
주소는 메뉴 `파일 > 서버 주소 변경…`에서 바꾼다.

## 빌드

    npm run dist:linux        # dist/ 에 AppImage, .deb

윈도우 설치 파일은 wine이 필요하므로 리눅스에서는 Docker로 빌드한다.

    docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp/home \
      -v /tmp/eb-home:/tmp/home -v "$PWD":"$PWD" -w "$PWD" \
      electronuserland/builder:wine npx electron-builder --win nsis portable

## 참고

- Ubuntu 24.04 이상에서 AppImage는 AppArmor의 user namespace 제한 때문에 `--no-sandbox` 없이는
  실행되지 않을 수 있다. `.deb`로 설치하면 샌드박스가 올바르게 설정된다.
- 윈도우 실행 파일은 코드 서명이 없어 첫 실행 시 SmartScreen 경고가 뜬다.
