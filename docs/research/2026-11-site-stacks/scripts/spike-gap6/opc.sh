cd /var/www/html
TOK='<hidden>'
HASH=$(php -r 'echo hash("sha256",$argv[1]);' $TOK)
UNTIL=$(($(date +%s)+600))
NAME=raditi-0123456789abcdef0123456789abcdef.php
sed "s/REPLACE_HASH/$HASH/; s/REPLACE_UNTIL/$UNTIL/" /tmp/probe.php > $NAME; chown www-data:www-data $NAME
call() { curl -s -H "X-Raditi-Token: $TOK" -H 'Content-Type: application/json' -d "$1" http://gap6-modx/$NAME; echo; }
echo "--- ini"; call '{}'
echo "--- wrong token"; curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Raditi-Token: nope' -d '{}' http://gap6-modx/$NAME
printf '<?php echo "CODE-v1";\n' > gapcode.php; chown www-data gapcode.php
sleep 3; curl -s http://gap6-modx/gapcode.php; echo; curl -s http://gap6-modx/gapcode.php; echo
printf '<?php echo "CODE-v2";\n' > gapcode.php; touch -d '+5 seconds' gapcode.php
sleep 7; echo "--- after write, no invalidate:"; curl -s http://gap6-modx/gapcode.php; echo
echo "--- invalidate through probe:"; call '{"invalidate":["gapcode.php"]}' | head -c 200; echo; curl -s http://gap6-modx/gapcode.php; echo
