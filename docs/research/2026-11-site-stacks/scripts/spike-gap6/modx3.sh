cd /var/www/html
q() { php -r '$m=new mysqli("gap6-db","root","<hidden>","mx");$m->query($argv[1]);' "$1"; }
page() { curl -s http://gap6-modx/ | grep -o 'MARK[^<]*' | head -1; }
find core/cache -mindepth 1 -delete; sleep 3; page; sleep 3; page
q "UPDATE modx_site_htmlsnippets SET snippet='MARK chunk-v5' WHERE name='gapchunk'"
echo "wipe core/cache after DB write"; find core/cache -mindepth 1 -delete; sleep 3
echo -n "GET1: "; page; sleep 3; echo -n "GET2: "; page; sleep 8; echo -n "GET3: "; page
