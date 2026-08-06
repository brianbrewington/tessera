// Throwaway probe for outline §7 / D7: what headers does a SAME-ORIGIN EventSource GET actually send?
// Fable's F3 claims it carries no Origin, which would make "reject missing Origin" reject our own client.
import { createServer } from "node:http";
const log = [];
const rec = (req) => {
  const h = req.headers;
  log.push({ path: req.url, method: req.method,
    origin: h.origin ?? "(ABSENT)", host: h.host ?? "(ABSENT)",
    secFetchSite: h["sec-fetch-site"] ?? "(ABSENT)", secFetchMode: h["sec-fetch-mode"] ?? "(ABSENT)",
    secFetchDest: h["sec-fetch-dest"] ?? "(ABSENT)" });
  console.log(JSON.stringify(log.at(-1)));
};
createServer((req, res) => {
  rec(req);
  if (req.url === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ chunk: 1, of: 3 })}\n\n`);
    setTimeout(() => res.write(`data: ${JSON.stringify({ chunk: 2, of: 3 })}\n\n`), 300);
    return;
  }
  if (req.url === "/ingest" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.url === "/report") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(log, null, 1)); return; }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><meta charset=utf8><title>D7 header probe</title>
<body style="font:14px system-ui;padding:2rem"><h1>D7 header probe</h1><pre id=o>running…</pre>
<script>
const es = new EventSource('/events');
let got = 0;
es.onmessage = e => { got++; document.getElementById('o').textContent = 'EventSource CONNECTED, messages received: ' + got; };
es.onerror = () => { document.getElementById('o').textContent = 'EventSource ERROR (got ' + got + ' messages)'; };
fetch('/ingest', { method:'POST', body:'x' });
</script></body>`);
}).listen(7777, "127.0.0.1", () => console.log("probe on http://127.0.0.1:7777"));
