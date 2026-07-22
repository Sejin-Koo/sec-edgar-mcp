# SEC EDGAR MCP 서버

## 로컬에서 압축 풀고 진행하는 순서

1. 압축을 풀고 해당 폴더로 이동합니다.
   ```
   cd sec-edgar-mcp
   ```

2. 패키지를 설치합니다.
   ```
   npm install
   ```

3. (선택) 로컬 테스트를 하려면:
   ```
   npm run dev
   ```
   브라우저에서 http://localhost:3000 접속 확인.

4. Vercel에 배포합니다.
   ```
   vercel --prod
   ```
   - 처음 실행하면 프로젝트 이름, 스코프 등을 물어봅니다. 기본값(Enter)으로 진행하면 됩니다.
   - 배포가 끝나면 `https://sec-edgar-mcp-xxxx.vercel.app` 같은 URL이 출력됩니다.

5. 환경변수 설정 (필수)
   - https://vercel.com 대시보드 → 방금 배포된 프로젝트 → Settings → Environment Variables
   - `SEC_USER_AGENT` = `포니링크 IT사업본부 실제이메일주소@ponylink.com` 형태로 등록
     (SEC는 User-Agent에 회사명+이메일이 없으면 요청을 차단합니다)
   - 저장 후 재배포: `vercel --prod` 다시 한 번 실행

6. claude.ai에 등록
   - claude.ai 설정 > 커넥터 > 사용자 지정 커넥터 추가
   - URL: `https://[배포된 주소]/mcp`

## 제공되는 도구 8개

- `search_company`: 회사명/티커로 CIK 검색
- `get_company_filings`: CIK로 최근 공시 목록(10-K, 10-Q, 8-K, 20-F 등) 조회
- `get_company_facts`: CIK로 XBRL 재무데이터(매출, 순이익 등) 조회
- `get_filing_section`: 10-K/20-F/8-K 원문에서 특정 섹션(지분구조, 위험요소 등)만 추출.
  keyword 없이 호출하면 문서 목차(Item 목록)를 먼저 보여줍니다.
- `get_insider_transactions`: Form 4(임원·주요주주 지분변동보고) 구조화 조회
  (거래일, 거래유형, 수량, 단가, 거래후 보유량)
- `full_text_search`: 키워드로 SEC 전체 공시 통합검색 (DART 공시검색과 유사, 회사명 없이도 검색 가능)
- `get_major_shareholders`: 13D/13G(5% 이상 주요주주 보고) 목록 및 표지 원문 발췌 조회
- `get_executive_compensation`: 최근 DEF 14A(주주총회소집통지)에서 임원보수 섹션 원문 추출

## get_filing_section 사용 팁

1. 먼저 keyword 없이 호출해서 목차를 확인: `get_filing_section(url=..., keyword 생략)`
2. 목차에서 원하는 항목명을 keyword로 넣어 재호출
   예) 20-F의 지분구조 → keyword: "Share Ownership"
   예) 10-K의 위험요소 → keyword: "Risk Factors"

## 참고

- SEC data.sec.gov API는 인증키가 필요 없습니다.
- 요청 빈도 제한: 초당 10회 권장 (SEC 공식 가이드라인)
