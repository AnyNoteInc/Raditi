HOST=${HOST:-gap6-prod}
rm -f /tmp/c
U=$(curl -s -c /tmp/c -b /tmp/c -L -o /tmp/login.html -w '%{url_effective}' -d 'username=admin&password=<hidden>' "http://$HOST/admin/index.php?route=common/login")
echo "$U" | sed 's/.*user_token=//' > /tmp/token
cat /tmp/token
