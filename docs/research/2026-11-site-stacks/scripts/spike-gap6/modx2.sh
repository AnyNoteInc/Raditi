cd /var/www/html
q() { php -r '$m=new mysqli("gap6-db","root","<hidden>","mx");$r=$m->query($argv[1]);if($r instanceof mysqli_result){while($x=$r->fetch_row())echo implode(" | ",$x),"\n";}' "$1"; }
page() { curl -s http://gap6-modx/ | grep -o 'MARK[^<]*' | tr '\n' ' '; echo; }
wipe() { find core/cache -mindepth 1 -delete; }
q "SELECT name,snippet FROM modx_site_snippets WHERE name LIKE 'gap%'"
echo "--- settled state, wait 4 s"; sleep 4; page
echo "--- again"; sleep 4; page
echo "--- write DB v3, no clear, wait 4"
q "UPDATE modx_site_htmlsnippets SET snippet='MARK chunk-v3' WHERE name='gapchunk'"
q "UPDATE modx_site_snippets SET snippet='return \"MARK snipcached-v3\";' WHERE name='gapsnip'"
q "UPDATE modx_site_snippets SET snippet='return \"MARK snipuncached-v3\";' WHERE name='gapsnipu'"
sleep 4; page
echo "--- remove core/cache/resource only, wait 4, two GETs"
find core/cache/resource -mindepth 1 -delete; sleep 4; page; sleep 4; page
echo "--- remove core/cache/includes+scripts, wait 4, two GETs"
find core/cache/includes core/cache/scripts -mindepth 1 -delete 2>/dev/null; sleep 4; page; sleep 4; page
echo "--- wipe all, wait 4, two GETs"
wipe; sleep 4; page; sleep 4; page
