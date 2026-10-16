#!/bin/sh
"$OC" serve --port 4096 --hostname 127.0.0.1 > /tmp/serve.log 2>&1 &
pid=$!
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null -m 1 http://127.0.0.1:4096/doc && break; sleep 0.5; done
curl -s -m 10 http://127.0.0.1:4096/doc > /tmp/doc.json; echo "doc bytes: $(wc -c < /tmp/doc.json)"
cp /tmp/doc.json /workspace/openapi-doc.json
node -e '
const d=JSON.parse(require("fs").readFileSync("/tmp/doc.json","utf8"));
console.log("openapi",d.openapi,"title",d.info?.title,"version",d.info?.version,"paths",Object.keys(d.paths).length);
for (const [p,ops] of Object.entries(d.paths)) { if (!/^\/(session|event|global|auth|config|provider|mcp)/.test(p)) continue; console.log(p, Object.entries(ops).map(([m,o])=>m.toUpperCase()+":"+(o.operationId??"")).join(" ")); }
const op=d.paths["/session/{sessionID}/message"]?.post ?? d.paths["/session/{id}/message"]?.post;
const body=op?.requestBody?.content?.["application/json"]?.schema; console.log("prompt body:", JSON.stringify(body).slice(0,1800));
'
head -5 /tmp/serve.log | cut -c1-200
kill -TERM $pid; wait $pid; echo "serve exit=$?"
