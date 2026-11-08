cd /var/www/html
HOST=gap6-oc4
php -r '
$m=new mysqli("gap6-db","root","<hidden>","oc4");
$xml=<<<X
<?xml version="1.0" encoding="utf-8"?><modification><name>Gap6 test</name><code>gap6</code><version>1</version><author>x</author><link>x</link>
<file path="catalog/view/template/common/footer.twig"><operation><search><![CDATA[</footer>]]></search><add position="before"><![CDATA[<!-- ocmod-marker -->]]></add></operation></file>
</modification>
X;
$s=$m->prepare("INSERT INTO oc_modification (extension_install_id,name,description,code,author,version,link,xml,status,date_added) VALUES (0,\"Gap6 test\",\"\",\"gap6\",\"x\",\"1\",\"x\",?,1,NOW())");
$s->bind_param("s",$xml);$s->execute();echo "rows=".$s->affected_rows."\n";
'
rm -f /tmp/c
curl -s -c /tmp/c -b /tmp/c -o /tmp/l.html "http://$HOST/admin/index.php?route=common/login"
LT=$(grep -o 'login_token=[a-f0-9A-Za-z]*' /tmp/l.html | head -1 | cut -d= -f2)
echo "login_token=$LT"
curl -s -c /tmp/c -b /tmp/c -o /tmp/l.json -d 'username=admin&password=<hidden>' "http://$HOST/admin/index.php?route=common/login.login&login_token=$LT"
head -c 200 /tmp/l.json; echo
T=$(grep -o 'user_token=[a-zA-Z0-9]*' /tmp/l.json | head -1 | cut -d= -f2)
echo "token=$T"; echo $T > /tmp/token
curl -s -c /tmp/c -b /tmp/c -o /tmp/r.json -w 'refresh http=%{http_code}\n' "http://$HOST/admin/index.php?route=marketplace/modification.refresh&user_token=$T"
head -c 200 /tmp/r.json; echo
find extension/ocmod -type f | sort | head -20
curl -s http://$HOST/ | grep -c ocmod-marker
php -r '
$m=new mysqli("gap6-db","root","<hidden>","oc4");
$code=htmlentities(file_get_contents("catalog/view/template/common/footer.twig")."<!-- from-oc-theme -->",ENT_QUOTES,"UTF-8");
$s=$m->prepare("INSERT INTO oc_theme (store_id,route,code,status,date_added) VALUES (0,\"common/footer\",?,1,NOW())");$s->bind_param("s",$code);$s->execute();echo $s->affected_rows,"\n";
'
curl -s http://$HOST/ > /tmp/p.html; echo "with overlay: oc_theme=$(grep -c from-oc-theme /tmp/p.html) ocmod=$(grep -c ocmod-marker /tmp/p.html)"
mv extension/ocmod/catalog /tmp/ocmod-catalog
curl -s http://$HOST/ > /tmp/p.html; echo "without overlay: oc_theme=$(grep -c from-oc-theme /tmp/p.html) ocmod=$(grep -c ocmod-marker /tmp/p.html)"
mv /tmp/ocmod-catalog extension/ocmod/catalog
php -r '$m=new mysqli("gap6-db","root","<hidden>","oc4");$m->query("DELETE FROM oc_theme");'
