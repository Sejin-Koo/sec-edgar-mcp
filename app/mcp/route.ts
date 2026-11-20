import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const USER_AGENT =
  process.env.SEC_USER_AGENT || "PonyLink IT-Division contact@example.com";

function pad10(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

// SEC 요청: 연결 실패·HTTP 5xx는 잠깐 쉬고 최대 3회 받는다(429·4xx는 그대로).
// 2026-11-20 04:24 full_text_search(efts) HTTP 500 1회, 같은 검색 재호출 정상 — 원천 일시 오류였다.
// 시도당 20초 제한(전에는 제한 없음).
async function secFetch(url: string): Promise<Response> {
  let lastErr: unknown = null;
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate" },
        signal: ac.signal,
      });
      if (res.status >= 500 && attempt < 2) {
        lastRes = res;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if ((e as Error).name === "AbortError" || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastRes) return lastRes;
  const e = lastErr as Error;
  throw new Error(
    e && e.name === "AbortError"
      ? `SEC 응답이 20초 안에 오지 않았습니다 (${url})`
      : `SEC 연결 실패: ${e && e.message} (3회 시도, ${url})`
  );
}

async function secFetchJson(url: string) {
  const res = await secFetch(url);
  if (!res.ok) {
    throw new Error(`SEC API 오류: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json();
}

async function secFetchText(url: string) {
  const res = await secFetch(url);
  if (!res.ok) {
    throw new Error(`SEC API 오류: ${res.status} ${res.statusText} (${url})`);
  }
  return res.text();
}

function stripHtml(html: string): string {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;|&#160;/gi, " ");
  text = text.replace(/&#8220;|&#8221;/g, '"');
  text = text.replace(/&#8217;|&#8216;/g, "'");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&#\d+;/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

// 표 셀 안쪽 HTML을 사람이 읽는 텍스트로 정리(줄바꿈 없는 짧은 텍스트 전용, stripHtml과 별도).
function stripHtmlInline(s: string): string {
  return (s || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

function xmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<value>)?([^<]*)`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

// SEC는 2025년경부터 일부 서식 표기를 변경했습니다 (예: "SC 13G/A" -> "SCHEDULE 13G/A").
// 신구 표기를 동일한 것으로 취급하기 위한 정규화 함수입니다.
function normalizeForm(form: string): string {
  return form
    .trim()
    .toUpperCase()
    .replace(/^SCHEDULE\s+/, "SC ")
    .replace(/\s+/g, " ");
}

function findOccurrences(text: string, keyword: string): number[] {
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  const indices: number[] = [];
  let pos = 0;
  while (indices.length < 30) {
    const idx = lower.indexOf(kw, pos);
    if (idx === -1) break;
    indices.push(idx);
    pos = idx + kw.length;
  }
  return indices;
}

function previewAt(text: string, idx: number, keywordLen: number): string {
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + keywordLen + 120);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

// 공시 index 페이지("Document Format Files" 표)를 파싱해서 그 공시에 포함된 모든 파일
// (본문 + Exhibit + 그래픽 등)의 목록을 구조화한다.
// (2026-08-02 추가: get_filing_section/get_executive_compensation이 본문(primaryDocument)
//  1개 파일만 조회하고 별도 첨부(Exhibit, 예: EX-21.1 자회사목록, EX-10.1 계약서 등)는
//  구조적으로 조회하지 못하던 것을 보완. KRX 별표 사고와 동일한 유형 — 다만 KRX와 달리
//  이 데이터는 사용자가 별도 저장해둔 것이 아니라 SEC가 공개 제공하는 index 페이지에서
//  바로 조회 가능하므로, Qdrant 등 별도 저장소 없이 SEC 서버에서 실시간으로 가져온다.)
interface FilingDocument {
  seq: string;
  description: string;
  filename: string | null;
  url: string;
  type: string;
  size: string;
  isExhibit: boolean;
}

function parseFilingIndexTable(html: string): FilingDocument[] {
  const tableMatch = html.match(
    /Document Format Files[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i
  );
  if (!tableMatch) return [];
  const tableHtml = tableMatch[1];
  const rows = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const docs: FilingDocument[] = [];
  for (const row of rows) {
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (!cells || cells.length < 4) continue;
    const cellTexts = cells.map((c) =>
      c.replace(/<td[^>]*>/i, "").replace(/<\/td>/i, "")
    );
    const [seqCell, descCell, docCell, typeCell, sizeCell] = cellTexts;
    const hrefMatch = docCell.match(/href="([^"]+)"/i);
    if (!hrefMatch) continue; // 링크 없는 행(헤더 등)은 건너뜀
    let href = hrefMatch[1];
    href = href.replace(/^\/ix\?doc=/, ""); // iXBRL 뷰어 링크 정리 → 실제 문서 경로만 남김
    const url = href.startsWith("http") ? href : `https://www.sec.gov${href}`;
    const filenameMatch = docCell.match(/>([^<]+\.[a-zA-Z0-9]+)\s*</);
    const type = stripHtmlInline(typeCell);
    docs.push({
      seq: stripHtmlInline(seqCell),
      description: stripHtmlInline(descCell),
      filename: filenameMatch ? filenameMatch[1] : null,
      url,
      type,
      size: stripHtmlInline(sizeCell || ""),
      isExhibit: /^EX-/i.test(type.trim()),
    });
  }
  // 그래픽(이미지)과 전체제출 텍스트파일(원본 그대로라 개별 문서보다 훨씬 크고 중복)은
  // 실무상 유용성이 낮아 기본 목록에서 제외한다.
  return docs.filter((d) => d.type !== "GRAPHIC" && d.filename && !d.filename.endsWith(".txt"));
}

let tickerCache: any[] | null = null;
let tickerCacheTime = 0;

async function getTickerList() {
  const now = Date.now();
  if (tickerCache && now - tickerCacheTime < 1000 * 60 * 60) {
    return tickerCache;
  }
  const data = await secFetchJson(
    "https://www.sec.gov/files/company_tickers.json"
  );
  const list = Object.values(data) as any[];
  tickerCache = list;
  tickerCacheTime = now;
  return list;
}

async function getSubmissions(cik: string) {
  return secFetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
}

function buildFilingRows(data: any, paddedCik: string) {
  const recent = data.filings?.recent;
  if (!recent) return [];
  return recent.form.map((form: string, i: number) => {
    const numericCik = parseInt(paddedCik, 10);
    const accessionNoDashes = recent.accessionNumber[i].replace(/-/g, "");
    return {
      form,
      filingDate: recent.filingDate[i],
      // 제출일(filingDate)과 별개인 '보고기준일'. 13F-HR의 분기말 등 기준시점 판단에 필요.
      reportDate: recent.reportDate?.[i] || null,
      accessionNumber: recent.accessionNumber[i],
      primaryDocument: recent.primaryDocument[i],
      reportUrl: `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accessionNoDashes}/${recent.primaryDocument[i]}`,
      // 이 공시에 포함된 모든 문서(본문+Exhibit) 목록은 list_filing_documents로 조회.
      indexUrl: `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accessionNoDashes}/${recent.accessionNumber[i]}-index.htm`,
    };
  });
}

async function fetchFilingDocuments(indexUrl: string): Promise<FilingDocument[]> {
  const html = await secFetchText(indexUrl);
  return parseFilingIndexTable(html);
}

// ─── 13F-HR 보유내역(INFORMATION TABLE) 파싱 ────────────────────────────────
// (2026-08-13 추가) 기관투자자의 분기말 미국주식 보유내역. xmlTag()는 여는 태그 뒤
// 텍스트만 잘라내므로 <votingAuthority><Sole>…</Sole></votingAuthority> 같은 중첩
// 구조를 못 읽는다. 그래서 여는/닫는 태그 쌍으로 블록 전체를 잡는 별도 헬퍼를 쓴다.
// 네임스페이스 프리픽스(ns1:infoTable 등)가 붙어 오는 제출인도 있어 함께 허용한다.
function xmlBlock(source: string, tag: string): string | null {
  const re = new RegExp(
    `<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`,
    "i"
  );
  const m = source.match(re);
  return m ? m[1].trim() : null;
}

interface Holding {
  nameOfIssuer: string | null;
  titleOfClass: string | null;
  cusip: string | null;
  value: number;
  shares: number;
  sharesType: string | null;
  investmentDiscretion: string | null;
  votingSole: number;
  votingShared: number;
  votingNone: number;
  lineItems?: number;
}

function parseInformationTable(xml: string): Holding[] {
  const blocks =
    xml.match(/<(?:\w+:)?infoTable[\s>][\s\S]*?<\/(?:\w+:)?infoTable>/gi) || [];
  return blocks.map((b) => {
    const va = xmlBlock(b, "votingAuthority") || "";
    return {
      nameOfIssuer: xmlBlock(b, "nameOfIssuer"),
      titleOfClass: xmlBlock(b, "titleOfClass"),
      cusip: xmlBlock(b, "cusip"),
      value: Number(xmlBlock(b, "value") || 0),
      shares: Number(xmlBlock(b, "sshPrnamt") || 0),
      sharesType: xmlBlock(b, "sshPrnamtType"),
      investmentDiscretion: xmlBlock(b, "investmentDiscretion"),
      votingSole: Number(xmlBlock(va, "Sole") || 0),
      votingShared: Number(xmlBlock(va, "Shared") || 0),
      votingNone: Number(xmlBlock(va, "None") || 0),
    };
  });
}

// 같은 종목이 운용역(otherManager)·재량구분별로 여러 행에 나뉘어 보고되는 것이 정상이다
// (버크셔 1개 분기 90행 → 종목 기준 29개). 종목 단위로 합산해야 실제 포지션이 보인다.
function consolidateHoldings(items: Holding[]): Holding[] {
  const map = new Map<string, Holding>();
  for (const it of items) {
    const key = `${it.cusip}|${it.titleOfClass}`;
    const prev = map.get(key);
    if (prev) {
      prev.value += it.value;
      prev.shares += it.shares;
      prev.votingSole += it.votingSole;
      prev.votingShared += it.votingShared;
      prev.votingNone += it.votingNone;
      prev.lineItems = (prev.lineItems || 1) + 1;
    } else {
      map.set(key, { ...it, lineItems: 1 });
    }
  }
  return Array.from(map.values());
}

const handler = createMcpHandler(
  async (server) => {
    server.tool(
      "search_company",
      "회사명 또는 티커로 SEC EDGAR에 등록된 회사를 검색하여 CIK 번호를 찾습니다.",
      {
        query: z.string().describe("회사명 또는 티커 심볼 (예: Apple, AAPL)"),
      },
      async ({ query }) => {
        const list = await getTickerList();
        const q = query.toLowerCase();
        const matches = list
          .filter(
            (item) =>
              item.title.toLowerCase().includes(q) ||
              item.ticker.toLowerCase() === q
          )
          .slice(0, 10)
          .map((item) => ({
            cik: pad10(item.cik_str),
            ticker: item.ticker,
            title: item.title,
          }));
        return {
          content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
        };
      }
    );

    server.tool(
      "get_company_filings",
      "CIK 번호로 회사의 최근 SEC 공시 목록(10-K, 10-Q, 8-K, 20-F 등)을 조회합니다. 각 건의 " +
        "reportUrl은 본문(primary document) 1개 파일만 가리키며, 그 공시에 딸린 첨부 " +
        "(Exhibit, 예: EX-10.1 계약서, EX-21.1 자회사목록)까지 보려면 같이 반환되는 indexUrl을 " +
        "list_filing_documents에 넣어 전체 문서 목록을 확인하세요.",
      {
        cik: z
          .string()
          .describe("10자리 CIK 번호 또는 숫자 (search_company로 확보)"),
        formType: z
          .string()
          .optional()
          .describe(
            "서식 유형 필터 (예: 10-K, 10-Q, 8-K, 20-F, SC 13G/A, 4). 신구 표기(SC ↔ SCHEDULE)를 자동으로 함께 매칭합니다. 생략시 전체"
          ),
        limit: z.coerce
          .number()
          .optional()
          .default(20)
          .describe("반환할 최대 건수"),
      },
      async ({ cik, formType, limit }) => {
        const paddedCik = pad10(cik);
        const data = await getSubmissions(paddedCik);
        const rows = buildFilingRows(data, paddedCik);
        if (rows.length === 0) {
          return {
            content: [{ type: "text", text: "공시 데이터를 찾을 수 없습니다." }],
          };
        }
        const filtered = formType
          ? rows.filter(
              (r: any) => normalizeForm(r.form) === normalizeForm(formType)
            )
          : rows;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyName: data.name,
                  cik: paddedCik,
                  filings: filtered.slice(0, limit),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "get_company_facts",
      "CIK 번호로 회사의 XBRL 재무데이터(매출, 순이익 등 US-GAAP 항목)를 조회합니다.",
      {
        cik: z.string().describe("10자리 CIK 번호 또는 숫자"),
        concept: z
          .string()
          .optional()
          .describe(
            "특정 US-GAAP 항목명 (예: Revenues, NetIncomeLoss). 생략시 사용 가능한 항목 목록만 반환"
          ),
      },
      async ({ cik, concept }) => {
        const paddedCik = pad10(cik);
        const data = await secFetchJson(
          `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`
        );
        const gaap = data.facts?.["us-gaap"];
        if (!gaap) {
          return {
            content: [
              { type: "text", text: "US-GAAP 재무데이터를 찾을 수 없습니다." },
            ],
          };
        }
        if (!concept) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    companyName: data.entityName,
                    availableConcepts: Object.keys(gaap).slice(0, 50),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const conceptData = gaap[concept];
        if (!conceptData) {
          return {
            content: [
              {
                type: "text",
                text: `'${concept}' 항목을 찾을 수 없습니다. concept 파라미터 없이 다시 조회해서 사용 가능한 항목명을 확인하세요.`,
              },
            ],
          };
        }
        const units = conceptData.units;
        const unitKey = Object.keys(units)[0];
        const values = units[unitKey]
          .filter((v: any) => v.form === "10-K" || v.form === "10-Q")
          .slice(-12);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyName: data.entityName,
                  concept,
                  unit: unitKey,
                  values,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "list_filing_documents",
      "특정 공시(accession)에 포함된 전체 문서 목록(본문 1개 + Exhibit·첨부 여러 개)을 SEC " +
        "EDGAR의 공시 index 페이지에서 실시간으로 가져옵니다. get_company_filings/full_text_search " +
        "결과의 indexUrl(또는 reportUrl에서 파일명만 다른 -index.htm URL)을 입력하세요. " +
        "get_filing_section·get_executive_compensation이 본문에서 키워드를 못 찾았을 때, " +
        "그 내용이 이 목록의 Exhibit(EX-10.1 계약서, EX-21.1 자회사목록, EX-99.1 보도자료 등) " +
        "중 하나에 있는 것은 아닌지 먼저 이 도구로 확인하세요 — 첨부는 별도 파일이라 본문 " +
        "조회 도구가 애초에 그 내용을 보지 못합니다. 원하는 Exhibit을 찾으면 그 url을 다시 " +
        "get_filing_section의 url 파라미터에 넣어 내용을 조회하면 됩니다.",
      {
        indexUrl: z
          .string()
          .describe(
            "공시 index 페이지 URL (get_company_filings/full_text_search 결과의 indexUrl/filingIndexUrl)"
          ),
      },
      async ({ indexUrl }) => {
        if (!indexUrl.startsWith("https://www.sec.gov/")) {
          return {
            content: [
              {
                type: "text",
                text: "보안상 sec.gov 도메인의 URL만 조회할 수 있습니다.",
              },
            ],
          };
        }
        const docs = await fetchFilingDocuments(indexUrl);
        if (docs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "문서 목록을 찾지 못했습니다. indexUrl이 '...-index.htm' 형식인지 확인하세요 " +
                  "(개별 문서 URL이 아니라 공시 전체의 색인 페이지여야 합니다).",
              },
            ],
          };
        }
        const primary = docs.filter((d) => !d.isExhibit);
        const exhibits = docs.filter((d) => d.isExhibit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  primaryDocuments: primary,
                  exhibits,
                  note:
                    exhibits.length > 0
                      ? `이 공시에는 본문 외에 첨부(Exhibit) ${exhibits.length}건이 있습니다. get_filing_section에서 본문 조회로 원하는 내용을 못 찾았다면 이 exhibits 목록의 url로 다시 조회해보세요.`
                      : "이 공시에는 별도 Exhibit이 없습니다.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "get_filing_section",
      "10-K, 20-F, 8-K 등 공시 문서 하나에서 특정 섹션(예: 위험요소, 지분구조, 재무제표 주석)만 " +
        "추출합니다. keyword를 생략하면 문서 내 주요 Item/섹션 목차를 반환합니다. url은 " +
        "get_company_filings 결과의 reportUrl(본문) 또는 list_filing_documents 결과의 " +
        "특정 Exhibit url을 사용하세요. ⚠️ 이 도구는 url로 지정한 문서 1개만 조회하며, 같은 " +
        "공시에 딸린 다른 첨부(Exhibit)는 조회하지 않습니다 — keyword를 못 찾았다고 해서 " +
        "그 내용이 공시 전체에 없다는 뜻은 아닙니다. 다른 Exhibit에 있을 수 있으니 먼저 " +
        "list_filing_documents로 그 공시의 전체 문서 목록을 확인하세요. 같은 keyword가 문서 " +
        "내 여러 곳(목차 + 실제 본문)에 나오면, 각 위치의 짧은 미리보기 목록을 먼저 반환합니다 " +
        "— 그중 원하는 위치의 번호를 occurrenceIndex로 다시 지정해서 호출하세요.",
      {
        url: z
          .string()
          .describe(
            "문서 URL (get_company_filings의 reportUrl 또는 list_filing_documents 결과의 exhibit url)"
          ),
        keyword: z
          .string()
          .optional()
          .describe(
            "찾을 섹션 키워드 (예: 'Share Ownership', 'Risk Factors', 'Item 7'). 생략시 목차 반환"
          ),
        occurrenceIndex: z.coerce
          .number()
          .optional()
          .describe(
            "keyword가 문서 내 여러 곳에서 발견될 때, 미리보기 목록에서 확인한 특정 위치 번호(1부터 시작)를 지정. 생략시 매칭이 1곳뿐이면 바로 반환, 여러 곳이면 미리보기 목록 반환"
          ),
        charsAfter: z.coerce
          .number()
          .optional()
          .default(6000)
          .describe("키워드 발견 지점부터 반환할 문자 수"),
      },
      async ({ url, keyword, occurrenceIndex, charsAfter }) => {
        if (!url.startsWith("https://www.sec.gov/")) {
          return {
            content: [
              {
                type: "text",
                text: "보안상 sec.gov 도메인의 URL만 조회할 수 있습니다.",
              },
            ],
          };
        }
        const html = await secFetchText(url);
        const text = stripHtml(html);

        if (!keyword) {
          const headingRe =
            /Item\s+\d+[A-Za-z]?\.\s?[A-Z][A-Za-z0-9,'\-\s]{3,60}/g;
          const found = new Set<string>();
          let m;
          while ((m = headingRe.exec(text)) && found.size < 60) {
            found.add(m[0].trim());
          }
          return {
            content: [
              {
                type: "text",
                text:
                  found.size > 0
                    ? "문서 내 주요 목차(Item):\n" + Array.from(found).join("\n")
                    : "Item 형식의 목차를 찾지 못했습니다. keyword를 직접 지정해서 검색해보세요 (예: 'Share Ownership').",
              },
            ],
          };
        }

        const occurrences = findOccurrences(text, keyword);
        if (occurrences.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `'${keyword}' 키워드를 이 문서에서 찾지 못했습니다. 이 도구는 url로 지정한 ` +
                  `문서 1개만 봅니다 — 같은 공시의 다른 Exhibit(첨부)에 있을 수 있으니, ` +
                  `list_filing_documents로 이 공시의 전체 문서 목록을 먼저 확인해보세요. ` +
                  `아니면 keyword 없이 이 도구를 다시 호출해 이 문서의 목차부터 확인해보세요.`,
              },
            ],
          };
        }

        if (!occurrenceIndex && occurrences.length > 1) {
          const previews = occurrences.map(
            (idx, i) =>
              `[${i + 1}] ...${previewAt(text, idx, keyword.length)}...`
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `'${keyword}'가 문서 내 ${occurrences.length}곳에서 발견되었습니다 (목차/본문/부록 등이 섞여있을 수 있음). 아래 미리보기를 보고 원하는 위치의 번호를 occurrenceIndex로 지정해서 다시 호출하세요.\n\n` +
                  previews.join("\n\n")
              },
            ],
          };
        }

        const chosenIdx = occurrences[(occurrenceIndex ?? 1) - 1] ?? occurrences[0];
        const snippet = text.slice(chosenIdx, chosenIdx + charsAfter);
        return {
          content: [{ type: "text", text: snippet }],
        };
      }
    );

    server.tool(
      "get_insider_transactions",
      "Form 4(임원·주요주주 지분변동보고) 최근 내역을 구조화된 형태로 조회합니다 (거래일, 거래유형, 수량, 단가, 거래후 보유량 포함).",
      {
        cik: z.string().describe("10자리 CIK 번호 또는 숫자"),
        limit: z.coerce
          .number()
          .optional()
          .default(10)
          .describe(
            "조회할 최근 Form 4 건수 (개별 XML을 순차 조회하므로 과도하게 크게 잡지 마세요)"
          ),
      },
      async ({ cik, limit }) => {
        const paddedCik = pad10(cik);
        const data = await getSubmissions(paddedCik);
        const rows = buildFilingRows(data, paddedCik).filter(
          (r: any) => normalizeForm(r.form) === "4"
        );
        const targets = rows.slice(0, Math.min(limit, 20));

        const results: any[] = [];
        for (const row of targets) {
          try {
            const xmlUrl = row.reportUrl.replace(/xslF345X06\//, "");
            const xml = await secFetchText(xmlUrl);
            results.push({
              filingDate: row.filingDate,
              reportingOwner: xmlTag(xml, "rptOwnerName"),
              securityTitle: xmlTag(xml, "securityTitle"),
              transactionDate: xmlTag(xml, "transactionDate"),
              transactionCode: xmlTag(xml, "transactionCode"),
              shares: xmlTag(xml, "transactionShares"),
              pricePerShare: xmlTag(xml, "transactionPricePerShare"),
              sharesOwnedAfter: xmlTag(xml, "sharesOwnedFollowingTransaction"),
              directOrIndirect: xmlTag(xml, "directOrIndirectOwnership"),
              sourceUrl: row.reportUrl,
            });
          } catch (e: any) {
            results.push({
              filingDate: row.filingDate,
              error: `원문 파싱 실패: ${e.message}`,
              sourceUrl: row.reportUrl,
            });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyName: data.name,
                  cik: paddedCik,
                  transactions: results,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
    server.tool(
      "full_text_search",
      "SEC EDGAR에 제출된 모든 상장사의 공시 원문을 키워드로 통합 검색합니다 (DART의 공시 통합검색과 유사). " +
        "특정 회사를 몰라도 키워드만으로 시장 전체를 검색할 수 있습니다. 결과의 filingIndexUrl을 " +
        "list_filing_documents에 넣으면 그 공시의 본문+Exhibit 전체 목록을 볼 수 있습니다.",
      {
        query: z
          .string()
          .describe("검색 키워드 또는 문구 (예: 'autonomous driving robotaxi China')"),
        forms: z
          .string()
          .optional()
          .describe("서식 유형 필터, 콤마로 구분 (예: '8-K,10-K'). 생략시 전체 서식"),
        startdt: z
          .string()
          .optional()
          .describe("검색 시작일 YYYY-MM-DD"),
        enddt: z.string().optional().describe("검색 종료일 YYYY-MM-DD"),
      },
      async ({ query, forms, startdt, enddt }) => {
        let url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(
          query
        )}`;
        if (forms) url += `&forms=${encodeURIComponent(forms)}`;
        if (startdt) url += `&startdt=${startdt}`;
        if (enddt) url += `&enddt=${enddt}`;

        const data = await secFetchJson(url);
        const hits = data.hits?.hits || [];
        const results = hits.map((h: any) => {
          const src = h._source;
          const cik = (src.ciks && src.ciks[0]) || "";
          const adshNoDash = (src.adsh || "").replace(/-/g, "");
          return {
            companies: src.display_names,
            form: src.root_form || src.file_type,
            fileDate: src.file_date,
            description: src.file_description,
            filingIndexUrl: cik
              ? `https://www.sec.gov/Archives/edgar/data/${parseInt(
                  cik,
                  10
                )}/${adshNoDash}/${src.adsh}-index.htm`
              : null,
          };
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { totalMatches: data.hits?.total?.value ?? results.length, results },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "get_major_shareholders",
      "Schedule 13D/13G(5% 이상 주요주주 보고) 공시 목록과 각 공시의 표지(보고인명·지분율 등 핵심 정보가 담긴 부분) 원문 발췌를 함께 조회합니다. 형식이 회사마다 조금씩 달라 완전 자동 구조화는 어려우니, 반환된 발췌 텍스트에서 지분율·보고인명을 직접 확인하세요.",
      {
        cik: z.string().describe("10자리 CIK 번호 또는 숫자"),
        limit: z.coerce
          .number()
          .optional()
          .default(5)
          .describe("조회할 최근 13D/13G 건수 (개별 문서를 순차 조회하므로 크게 잡지 마세요)"),
      },
      async ({ cik, limit }) => {
        const paddedCik = pad10(cik);
        const data = await getSubmissions(paddedCik);
        const targetForms = ["SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A"];
        const rows = buildFilingRows(data, paddedCik).filter((r: any) =>
          targetForms.includes(normalizeForm(r.form))
        );
        const targets = rows.slice(0, Math.min(limit, 15));

        const results: any[] = [];
        for (const row of targets) {
          try {
            const html = await secFetchText(row.reportUrl);
            const text = stripHtml(html);
            results.push({
              form: row.form,
              filingDate: row.filingDate,
              coverPageExcerpt: text.slice(0, 2500),
              sourceUrl: row.reportUrl,
            });
          } catch (e: any) {
            results.push({
              form: row.form,
              filingDate: row.filingDate,
              error: `원문 조회 실패: ${e.message}`,
              sourceUrl: row.reportUrl,
            });
          }
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "해당 CIK로 제출된 13D/13G 공시를 찾지 못했습니다. 외국민간발행인(Foreign Private Issuer)의 경우 20-F 연차보고서의 'Major Shareholders' 섹션에 지분정보가 대신 포함될 수 있습니다 (get_filing_section 도구 활용).",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { companyName: data.name, cik: paddedCik, filings: results },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "get_executive_compensation",
      "가장 최근 주주총회소집통지(DEF 14A Proxy Statement)에서 임원보수 관련 섹션(Summary " +
        "Compensation Table 등) 원문을 추출합니다. keyword가 문서 내 여러 곳(목차 + 실제 " +
        "데이터표 + 부록 등)에 나오면 각 위치의 짧은 미리보기 목록을 먼저 반환하니, 원하는 " +
        "위치 번호를 occurrenceIndex로 지정해서 다시 호출하세요. DEF 14A는 보통 단일 문서지만, " +
        "찾는 내용이 없으면 list_filing_documents로 이 공시에 다른 첨부가 있는지도 확인하세요.",
      {
        cik: z.string().describe("10자리 CIK 번호 또는 숫자"),
        keyword: z
          .string()
          .optional()
          .default("Summary Compensation Table")
          .describe(
            "찾을 섹션 키워드 (기본값: 'Summary Compensation Table'). 다른 항목 원하면 예: 'Director Compensation'"
          ),
        occurrenceIndex: z.coerce
          .number()
          .optional()
          .describe(
            "keyword가 여러 곳에서 발견될 때, 미리보기 목록에서 확인한 위치 번호(1부터 시작) 지정"
          ),
        charsAfter: z.coerce
          .number()
          .optional()
          .default(6000)
          .describe("키워드 발견 지점부터 반환할 문자 수"),
      },
      async ({ cik, keyword, occurrenceIndex, charsAfter }) => {
        const paddedCik = pad10(cik);
        const data = await getSubmissions(paddedCik);
        const rows = buildFilingRows(data, paddedCik).filter(
          (r: any) => normalizeForm(r.form) === "DEF 14A"
        );
        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "DEF 14A(주주총회소집통지) 공시를 찾지 못했습니다. 외국민간발행인은 DEF 14A 대신 20-F 'Item 6.B Compensation' 섹션에 임원보수 정보가 포함됩니다 (get_filing_section 도구 활용).",
              },
            ],
          };
        }
        const latest = rows[0];
        const html = await secFetchText(latest.reportUrl);
        const text = stripHtml(html);
        const occurrences = findOccurrences(text, keyword);
        if (occurrences.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `'${keyword}' 키워드를 최근 DEF 14A(제출일 ${latest.filingDate})에서 찾지 ` +
                  `못했습니다. get_filing_section 도구로 이 문서의 목차를 먼저 확인해보거나, ` +
                  `list_filing_documents(indexUrl="${latest.indexUrl}")로 이 공시에 다른 첨부가 ` +
                  `있는지 확인해보세요. 문서 URL: ${latest.reportUrl}`,
              },
            ],
          };
        }

        if (!occurrenceIndex && occurrences.length > 1) {
          const previews = occurrences.map(
            (idx, i) =>
              `[${i + 1}] ...${previewAt(text, idx, keyword.length)}...`
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `'${keyword}'가 문서(제출일 ${latest.filingDate}) 내 ${occurrences.length}곳에서 발견되었습니다 (목차/실제 데이터표/동종업계 비교부록 등이 섞여있을 수 있음). 아래 미리보기를 보고 원하는 위치 번호를 occurrenceIndex로 지정해서 다시 호출하세요.\n\n` +
                  previews.join("\n\n")
              },
            ],
          };
        }

        const chosenIdx =
          occurrences[(occurrenceIndex ?? 1) - 1] ?? occurrences[0];
        const snippet = text.slice(chosenIdx, chosenIdx + charsAfter);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyName: data.name,
                  filingDate: latest.filingDate,
                  sourceUrl: latest.reportUrl,
                  excerpt: snippet,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "get_institutional_holdings",
      "기관투자자(자산운용사·헤지펀드·연기금·은행 등)가 제출한 Form 13F-HR의 분기말 미국주식 " +
        "보유내역을 조회합니다. cik에는 **조회 대상 기관투자자의 CIK**를 넣습니다 (예: 버크셔 " +
        "해서웨이 1067983, 뱅가드·블랙록 등). 보유 종목명·CUSIP·평가액·보유주식수·의결권 구분이 " +
        "반환됩니다. ⚠️ 일반 사업회사의 CIK를 넣으면 조회되지 않습니다 — 13F는 미국주식 운용자산 " +
        "1억달러 이상 기관투자자만 제출하는 서식이라, '이 회사의 주주가 누구인가'(역방향)를 보려면 " +
        "get_major_shareholders(13D/13G, 5% 이상 주주)를 사용하세요. 같은 종목이 운용역별로 여러 " +
        "행에 나뉘어 보고되므로 기본값(consolidate=true)은 종목 단위로 합산해서 반환합니다.",
      {
        cik: z
          .string()
          .describe(
            "기관투자자(13F 제출인)의 10자리 CIK 번호 또는 숫자 (search_company로 확보)"
          ),
        limit: z.coerce
          .number()
          .optional()
          .default(50)
          .describe("반환할 보유종목 수 (평가액 큰 순). 전체 종목 수는 totalPositions로 확인"),
        filingIndex: z.coerce
          .number()
          .optional()
          .default(0)
          .describe(
            "조회할 13F-HR 회차. 0이 최신 분기, 1이 직전 분기…(분기별 변동 추적 시 사용)"
          ),
        consolidate: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "같은 종목(CUSIP)이 여러 행으로 나뉘어 보고된 것을 합산할지 여부. false면 원문 행을 그대로 반환"
          ),
        issuerContains: z
          .string()
          .optional()
          .describe("특정 종목만 필터링 (발행회사명 부분일치, 예: 'apple')"),
      },
      async ({ cik, limit, filingIndex, consolidate, issuerContains }) => {
        const paddedCik = pad10(cik);
        const data = await getSubmissions(paddedCik);
        const rows = buildFilingRows(data, paddedCik).filter((r: any) =>
          normalizeForm(r.form).startsWith("13F-HR")
        );
        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `CIK ${paddedCik}(${data.name})로 제출된 13F-HR 공시를 찾지 못했습니다. ` +
                  `13F-HR은 미국주식 운용자산 1억달러 이상인 기관투자자만 제출하는 서식이므로, ` +
                  `일반 사업회사 CIK로는 조회되지 않습니다. 반대로 '이 회사의 주요주주가 누구인가'를 ` +
                  `보시려면 get_major_shareholders(13D/13G)를 사용하세요.`,
              },
            ],
          };
        }

        const row = rows[Math.min(Math.max(filingIndex, 0), rows.length - 1)];
        const docs = await fetchFilingDocuments(row.indexUrl);
        // index 표에는 같은 문서가 XSL 뷰어 경로와 원본 XML 경로로 2번 나온다. 원본을 우선한다.
        const info =
          docs.find(
            (d) => /INFORMATION TABLE/i.test(d.type) && !/xslForm13F/i.test(d.url)
          ) || docs.find((d) => /INFORMATION TABLE/i.test(d.type));
        if (!info) {
          return {
            content: [
              {
                type: "text",
                text:
                  `이 13F-HR 공시(제출일 ${row.filingDate})에서 INFORMATION TABLE 문서를 ` +
                  `찾지 못했습니다. list_filing_documents(indexUrl="${row.indexUrl}")로 ` +
                  `이 공시의 전체 문서 목록을 직접 확인해보세요. 보유내역 없이 표지만 제출하는 ` +
                  `13F-NT(Notice)일 수도 있습니다.`,
              },
            ],
          };
        }

        const xmlUrl = info.url.replace(/xslForm13F_X\d+\//, "");
        let items = parseInformationTable(await secFetchText(xmlUrl));
        if (items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `INFORMATION TABLE 파싱 결과가 0건입니다. 원문을 직접 확인하세요: ${xmlUrl}`,
              },
            ],
          };
        }
        if (consolidate) items = consolidateHoldings(items);
        if (issuerContains) {
          const q = issuerContains.toLowerCase();
          items = items.filter((i) =>
            (i.nameOfIssuer || "").toLowerCase().includes(q)
          );
        }
        const totalValue = items.reduce((s, i) => s + i.value, 0);
        items.sort((a, b) => b.value - a.value);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  filerName: data.name,
                  cik: paddedCik,
                  form: row.form,
                  filingDate: row.filingDate,
                  reportPeriod: row.reportDate,
                  availableFilings: rows.length,
                  consolidated: consolidate,
                  totalPositions: items.length,
                  totalValue,
                  valueUnitNote:
                    "value는 SEC 규정 개정에 따라 2023년 이후 제출분부터 '달러 단위'로 보고됩니다(그 이전 제출분은 '천달러 단위'). reportPeriod를 확인해 해석하세요.",
                  sourceUrl: xmlUrl,
                  filingIndexUrl: row.indexUrl,
                  holdings: items.slice(0, limit),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "fetch_frames",
      "XBRL Frames API — 특정 재무항목 1개를 **전체 미국 상장사 횡단**으로 한 번에 조회합니다. " +
        "회사별로 하나씩 조회하는 get_company_facts와 반대 방향이며, 동종업계 피어그룹 스크리닝· " +
        "업종 벤치마킹·순위 산출에 사용합니다 (예: 'CY2024 매출 상위 기업', '2024년말 총자산 " +
        "규모 비교'). period 형식이 항목 성격에 따라 다르니 주의하세요 — 재무상태표 항목(자산· " +
        "부채·자본 등 시점 값)은 'CY2024Q1I'처럼 끝에 I를 붙이고 분기 단위만 지원하며, 손익· " +
        "현금흐름 항목(매출·이익 등 기간 값)은 'CY2024Q1'(분기) 또는 'CY2024'(연간)를 씁니다. " +
        "형식이 틀려 404가 나면 I를 붙이거나 뗀 형태로 자동 재시도하고 결과에 periodUsed로 알려줍니다. " +
        "concept명을 모르면 get_company_facts를 concept 없이 호출해 그 회사의 항목 목록부터 확인하세요.",
      {
        concept: z
          .string()
          .describe(
            "XBRL 항목명 (대소문자 구분, 예: Assets, Liabilities, Revenues, NetIncomeLoss, StockholdersEquity, OperatingIncomeLoss)"
          ),
        period: z
          .string()
          .describe(
            "조회 기간. 시점항목(재무상태표)은 'CY2024Q1I'·'CY2024Q4I'처럼 I 접미사 + 분기만 가능. 기간항목(손익)은 'CY2024Q1'(분기) 또는 'CY2024'(연간)"
          ),
        unit: z
          .string()
          .optional()
          .default("USD")
          .describe("단위 (기본 USD. 주식수는 'shares', 주당금액은 'USD-per-shares')"),
        taxonomy: z
          .string()
          .optional()
          .default("us-gaap")
          .describe("분류체계 (기본 us-gaap. 그 밖에 ifrs-full, dei)"),
        limit: z.coerce
          .number()
          .optional()
          .default(50)
          .describe(
            "반환할 기업 수. 프레임 전체 기업 수는 totalCompaniesInFrame으로 확인 (수천 건이므로 전량 반환하지 않음)"
          ),
        sort: z
          .enum(["desc", "asc"])
          .optional()
          .default("desc")
          .describe("값 기준 정렬. desc=큰 순(기본), asc=작은 순"),
        nameContains: z
          .string()
          .optional()
          .describe(
            "기업명 부분일치 필터 (예: 'motor'). 특정 기업 몇 곳만 골라 비교할 때 사용"
          ),
      },
      async ({ concept, period, unit, taxonomy, limit, sort, nameContains }) => {
        // 요청 형식 그대로 먼저 시도하고, 404면 I 접미사를 토글해서 한 번 더 시도한다.
        const candidates = [period];
        candidates.push(
          /I$/.test(period) ? period.replace(/I$/, "") : `${period}I`
        );

        let data: any = null;
        let usedPeriod: string | null = null;
        const errors: string[] = [];
        for (const p of candidates) {
          const url = `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${concept}/${unit}/${p}.json`;
          const res = await secFetch(url);
          if (res.ok) {
            data = await res.json();
            usedPeriod = p;
            break;
          }
          errors.push(`${p}: HTTP ${res.status}`);
        }

        if (!data) {
          return {
            content: [
              {
                type: "text",
                text:
                  `프레임 데이터를 찾지 못했습니다 (${errors.join(", ")}).\n` +
                  `확인사항\n` +
                  `1) concept 철자 — 대소문자를 구분합니다 (예: Assets, Revenues, NetIncomeLoss). ` +
                  `정확한 항목명은 get_company_facts를 concept 없이 호출해 확인하세요.\n` +
                  `2) period 형식 — 시점항목(자산·부채·자본)은 'CY2024Q1I'처럼 I를 붙이고 분기만 지원, ` +
                  `기간항목(매출·이익)은 'CY2024Q1' 또는 'CY2024'.\n` +
                  `3) unit — 금액은 USD, 주식수는 shares, 주당금액은 USD-per-shares.\n` +
                  `4) taxonomy — us-gaap / ifrs-full / dei.\n` +
                  `5) 해당 분기 프레임 자체가 아직 생성되지 않았을 수 있습니다(최근 분기는 공시가 ` +
                  `충분히 쌓인 뒤 제공).`,
              },
            ],
          };
        }

        const all: any[] = data.data || [];
        let rows = all;
        if (nameContains) {
          const q = nameContains.toLowerCase();
          rows = rows.filter((d) =>
            (d.entityName || "").toLowerCase().includes(q)
          );
        }
        const matched = rows.length;
        rows = [...rows]
          .sort((a, b) => (sort === "asc" ? a.val - b.val : b.val - a.val))
          .slice(0, limit);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  taxonomy: data.taxonomy,
                  tag: data.tag,
                  label: data.label,
                  unit: data.uom,
                  periodRequested: period,
                  periodUsed: usedPeriod,
                  autoCorrected:
                    usedPeriod !== period
                      ? `요청하신 '${period}' 프레임이 없어 '${usedPeriod}'로 자동 대체 조회했습니다. ` +
                        `(시점항목/기간항목 구분에 따른 형식 차이)`
                      : undefined,
                  totalCompaniesInFrame: all.length,
                  matchedAfterFilter: matched,
                  returned: rows.length,
                  data: rows.map((d) => ({
                    cik: pad10(d.cik),
                    entityName: d.entityName,
                    loc: d.loc,
                    start: d.start,
                    end: d.end,
                    val: d.val,
                    accn: d.accn,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  },
  {},
  { basePath: "" }
);

// ─── 접근 게이트 ─────────────────────────────────────────────────────────────
// 엔드포인트 주소만 알면 누구나 호출할 수 있는 상태를 막기 위해, 호출자는 URL
// 쿼리스트링으로 발급받은 게이트키를 전달한다:  https://<도메인>/mcp?k=<발급키>
//   MCP_GATE_KEYS : 허용 키 목록(쉼표 구분). **비어 있으면 게이트 비활성**(모두 통과).
//   MCP_GATE_MODE : "enforce"면 키가 없거나 목록에 없을 때 401 차단.
//                   그 밖(기본 "observe")이면 통과시키되 로그만 남긴다.
// 상세 운영 절차는 sys-mcp-gatekey 스킬 참조.
const GATE_KEYS = (process.env.MCP_GATE_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();

function gateKeyLabel(k: string | null): string {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

function withGate(h: any) {
  return async (req: Request, ctx: any) => {
    let k: string | null = null;
    try {
      k = new URL(req.url).searchParams.get("k");
    } catch (e) {
      k = null;
    }
    const allowed = GATE_KEYS.length === 0 || (!!k && GATE_KEYS.includes(k));
    console.log(
      `[gate] mode=${GATE_MODE} method=${req.method} caller=${gateKeyLabel(k)} allowed=${allowed}`
    );
    if (!allowed && GATE_MODE === "enforce") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32001,
            message:
              "접근 권한이 없습니다. 이 서버는 발급받은 게이트키가 포함된 주소(…/mcp?k=<발급키>)로만 호출할 수 있습니다.",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    return h(req, ctx);
  };
}

export const GET = withGate(handler);
export const POST = withGate(handler);
export const DELETE = withGate(handler);
