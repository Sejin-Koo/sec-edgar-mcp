export default function Home() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>SEC EDGAR MCP Server</h1>
      <p>MCP endpoint: <code>/mcp</code></p>
      <p>이 URL을 claude.ai 커넥터 설정에 등록하세요: https://[배포주소]/mcp</p>
    </main>
  );
}
