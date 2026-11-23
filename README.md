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

## 빌드와 배포

    npm run release -- --build-only   # dist/ 에 설치 파일만 빌드
    npm run release -- --draft        # 빌드 후 GitHub 릴리스 초안으로 업로드
    npm run release                   # 빌드 후 바로 공개 릴리스

새 버전을 낼 때는 `package.json`의 `version`을 올리고 커밋한 뒤 `npm run release`를 실행한다.
윈도우 설치 파일은 wine이 필요해서 스크립트가 Docker(`electronuserland/builder:wine`)로 빌드하며,
업로드에는 로그인된 `gh`가 필요하다.

## 자동 업데이트

앱은 시작할 때 GitHub Releases의 최신 정식 릴리스를 확인한다(메뉴 `파일 > 업데이트 확인…`으로 수동 확인).
Pre-release와 초안은 대상에서 빠진다.

- 윈도우 설치형, 리눅스 AppImage: 새 버전을 자동으로 내려받고 재시작 여부를 묻는다.
- 윈도우 포터블, 리눅스 .deb: 새 버전이 있다는 알림과 다운로드 페이지 링크만 보여 준다.

릴리스에는 설치 파일과 함께 `latest.yml`, `latest-linux.yml`, `.blockmap`이 반드시 올라가야 한다.

## 참고

- Ubuntu 24.04 이상에서 AppImage는 AppArmor의 user namespace 제한 때문에 `--no-sandbox` 없이는
  실행되지 않을 수 있고, `libfuse2`도 필요하다. `.deb`로 설치하면 샌드박스가 올바르게 설정된다.
- 윈도우 실행 파일은 코드 서명이 없어 첫 실행 시 SmartScreen 경고가 뜬다.
