cd /var/www/html
q() { php -r '$m=new mysqli("gap6-db","root","<hidden>","mx");$r=$m->query($argv[1]);' "$1"; }
page() { curl -s http://gap6-modx/ | grep -o 'MARK[^<]*' | tr '\n' ' '; echo; }
TOK='<hidden>'
HASH=$(php -r 'echo hash("sha256",$argv[1]);' $TOK)
NAME=raditi-0123456789abcdef0123456789abcdef.php
sed "s/REPLACE_HASH/$HASH/" /tmp/probe2.php > $NAME; chown www-data:www-data $NAME
q "INSERT INTO modx_site_htmlsnippets (name,description,snippet) VALUES ('gapchunk','','MARK chunk-v1')"
q "INSERT INTO modx_site_snippets (name,description,snippet) VALUES ('gapsnip','','return \"MARK snipcached-v1\";')"
q "UPDATE modx_site_templates SET content='<html><body><div>[[\$gapchunk]]</div><div>[[gapsnip]]</div></body></html>' WHERE id=1"
find core/cache -mindepth 1 -delete; sleep 3
echo -n "start  : "; page; sleep 2; echo -n "cached : "; page
q "UPDATE modx_site_htmlsnippets SET snippet='MARK chunk-v2' WHERE name='gapchunk'"
q "UPDATE modx_site_snippets SET snippet='return \"MARK snipcached-v2\";' WHERE name='gapsnip'"
echo "drop through the probe (invalidate, then unlink):"
curl -s -H "X-Raditi-Token: $TOK" -d '{}' http://gap6-modx/$NAME; echo
sleep 1; echo -n "GET1   : "; page; sleep 2; echo -n "GET2   : "; page; sleep 8; echo -n "GET3   : "; page
echo "--- expiry"; touch -d '-20 minutes' $NAME; curl -s -o /dev/null -w 'http %{http_code}\n' -H "X-Raditi-Token: $TOK" -d '{}' http://gap6-modx/$NAME; ls $NAME 2>&1 | tail -1
