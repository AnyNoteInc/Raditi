#!/bin/bash
# probe.sh <tag> <host> <port> <path>...: status, size, title and the PHP errors a path gives.
tag=$1; host=$2; port=$3; shift 3
for p in "$@"; do
  r=$(curl -s -m 30 -o /tmp/bs-probe.html -w '%{http_code} %{size_download} %{redirect_url}' -H "Host: $host:$port" "http://127.0.0.1:$port$p")
  t=$(sed -n 's/.*<title>\([^<]*\).*/\1/p' /tmp/bs-probe.html | head -1 | cut -c1-70)
  f=$(grep -ciE 'fatal error|parse error|exception|warning:|notice:' /tmp/bs-probe.html)
  printf '%-44s %s | %s | err-words=%s\n' "$p" "$r" "$t" "$f"
done
