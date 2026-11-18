export default function Page() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "72px 24px" }}>
      <p style={{ letterSpacing: "0.18em", textTransform: "uppercase", fontSize: 12 }}>AURELIA</p>
      <h1 style={{ fontWeight: 500, fontSize: 48, margin: "12px 0" }}>Commerce API</h1>
      <p style={{ lineHeight: 1.6 }}>
        Catalog, cart, checkout, orders, and the shopping assistant live under <code>/v1</code>. Start with{" "}
        <a href="/v1/health" style={{ color: "#C39A5B" }}>/v1/health</a>.
      </p>
    </main>
  );
}
