HOST=${HOST:-gap6-prod}
T=$(cat /tmp/token)
curl -s -b /tmp/c -c /tmp/c -L -o /tmp/r.html -w 'refresh http=%{http_code} time=%{time_total}\n' "http://$HOST/admin/index.php?route=marketplace/modification/refresh&user_token=$T"
