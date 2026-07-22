export const metadata = {
  title: "SEC EDGAR MCP",
  description: "SEC EDGAR MCP server for Claude",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
