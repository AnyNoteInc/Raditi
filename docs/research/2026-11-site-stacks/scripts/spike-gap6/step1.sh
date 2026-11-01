set -u
cd /var/www/html
HOST=${HOST:-gap6-prod}
php -r '
$m=new mysqli("gap6-db","root","<hidden>",getenv("DBN")?:"oc");
$xml=<<<X
<?xml version="1.0" encoding="utf-8"?><modification><name>Gap6 test</name><code>gap6</code><version>1</version><author>x</author><link>x</link>
<file path="catalog/view/theme/*/template/common/footer.twig"><operation><search><![CDATA[</footer>]]></search><add position="before"><![CDATA[<!-- ocmod-marker -->]]></add></operation></file>
<file path="catalog/controller/common/footer.php"><operation><search><![CDATA[\$data[\x27contact\x27] =]]></search><add position="before"><![CDATA[\$data[\x27gap6\x27] = \x27ocmod-controller\x27;]]></add></operation></file>
</modification>
X;
$s=$m->prepare("INSERT INTO oc_modification (extension_install_id,name,code,author,version,link,xml,status,date_added) VALUES (0,\"Gap6 test\",\"gap6\",\"x\",\"1\",\"x\",?,1,NOW())");
$s->bind_param("s",$xml);$s->execute();echo "rows=".$s->affected_rows."\n";
'
