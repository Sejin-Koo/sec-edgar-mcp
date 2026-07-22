import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const USER_AGENT =
  process.env.SEC_USER_AGENT || "PonyLink IT-Division contact@example.com";

function pad10(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

async function secFetchJson(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "gzip, deflate",
    },
  });
  if (!res.ok) {
    throw new Error(`SEC API 오류: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json();
}

async function secFetchText(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "gzip, deflate",
    },
  });
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
  return recent.form.map((form: string, i: number) => ({
    form,
    filingDate: recent.filingDate[i],
    accessionNumber: recent.accessionNumber[i],
    primaryDocument: recent.primaryDocument[i],
    reportUrl: `https://www.sec.gov/Archives/edgar/data/${parseInt(
      paddedCik,
      10
    )}/${recent.accessionNumber[i].replace(/-/g, "")}/${
      recent.primaryDocument[i]
    }`,
  }));
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
      "CIK 번호로 회사의 최근 SEC 공시 목록(10-K, 10-Q, 8-K, 20-F 등)을 조회합니다.",
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
      "get_filing_section",
      "10-K, 20-F, 8-K 등 공시 원문 문서에서 특정 섹션(예: 위험요소, 지분구조, 재무제표 주석)만 추출합니다. keyword를 생략하면 문서 내 주요 Item/섹션 목차를 반환합니다. url은 get_company_filings 결과의 reportUrl을 사용하세요. 같은 keyword가 문서 내 여러 곳(목차 + 실제 본문)에 나오면, 각 위치의 짧은 미리보기 목록을 먼저 반환합니다 — 그중 원하는 위치의 번호를 occurrenceIndex로 다시 지정해서 호출하세요.",
      {
        url: z.string().describe("문서 URL (get_company_filings의 reportUrl)"),
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
                text: `'${keyword}' 키워드를 문서에서 찾지 못했습니다. keyword 없이 다시 호출해 목차를 확인해보세요.`,
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
      "SEC EDGAR에 제출된 모든 상장사의 공시 원문을 키워드로 통합 검색합니다 (DART의 공시 통합검색과 유사). 특정 회사를 몰라도 키워드만으로 시장 전체를 검색할 수 있습니다.",
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
      "가장 최근 주주총회소집통지(DEF 14A Proxy Statement)에서 임원보수 관련 섹션(Summary Compensation Table 등) 원문을 추출합니다. keyword가 문서 내 여러 곳(목차 + 실제 데이터표 + 부록 등)에 나오면 각 위치의 짧은 미리보기 목록을 먼저 반환하니, 원하는 위치 번호를 occurrenceIndex로 지정해서 다시 호출하세요.",
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
                text: `'${keyword}' 키워드를 최근 DEF 14A(제출일 ${latest.filingDate})에서 찾지 못했습니다. get_filing_section 도구로 문서 목차를 먼저 확인해보세요. 문서 URL: ${latest.reportUrl}`,
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
  },
  {},
  { basePath: "" }
);

export { handler as GET, handler as POST, handler as DELETE };
