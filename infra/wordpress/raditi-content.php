<?php
/**
 * Plugin Name: Raditi bounded published content
 * Description: Local P6 companion. Only title/content/excerpt of public posts and pages.
 * This slice deliberately bypasses save hooks, builders, revisions and arbitrary REST data.
 */
if (!defined('ABSPATH')) { exit; }

function raditi_content_permission($request) {
    $site = get_option('raditi_content_site_id', '');
    return did_action('application_password_did_authenticate') > 0
        && is_string($site) && $site !== ''
        && hash_equals($site, (string) $request->get_header('x-raditi-site'))
        && (current_user_can('edit_posts') || current_user_can('edit_pages'));
}

// The optional reason says why a value is invalid here: 'markup', 'size' or 'storage'.
function raditi_content_rejected($code, $reason = null) {
    $body = array('version' => 1, 'kind' => 'rejected', 'code' => $code);
    if ($reason !== null) { $body['reason'] = $reason; }
    return new WP_REST_Response($body, 200);
}

function raditi_content_uuid($value) {
    return is_string($value) && preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/D', $value);
}

// wpdb may reconnect and retry a query after losing its connection. A transaction must not
// continue on another connection: use its mysqli handle directly, with no reconnect/retry.
// wpdb::prepare() hides every literal % behind a per-request placeholder that only
// wpdb::query() turns back. Do the same here, or the placeholder itself gets stored.
function raditi_content_sql($query) {
    global $wpdb;
    try { return $wpdb->dbh instanceof mysqli ? mysqli_query($wpdb->dbh, $wpdb->remove_placeholder_escape($query)) : false; }
    catch (Throwable $error) { return false; }
}

function raditi_content_sql_value($query) {
    $result = raditi_content_sql($query);
    if (!$result instanceof mysqli_result) { return null; }
    $row = mysqli_fetch_row($result);
    mysqli_free_result($result);
    return $row ? $row[0] : null;
}

function raditi_content_state($row) {
    if (!$row || !in_array($row->post_type, array('post', 'page'), true)
        || $row->post_status !== 'publish' || $row->post_password !== '') { return null; }
    $state = array('version' => 1, 'objectRef' => $row->post_type . ':' . $row->ID,
        'kind' => $row->post_type, 'title' => $row->post_title,
        'content' => $row->post_content, 'excerpt' => $row->post_excerpt);
    $material = '';
    foreach (array($state['objectRef'], $state['kind'], 'publish', '',
        $state['title'], $state['content'], $state['excerpt']) as $value) {
        $material .= strlen($value) . ':' . $value;
    }
    $state['stateHash'] = hash('sha256', $material);
    return $state;
}

// The platform snapshots a state as JSON with raw UTF-8 and limits those bytes. Count the
// same bytes here: the default \uXXXX escapes would triple the size of Cyrillic text.
function raditi_content_too_large($state) {
    // PHP 7.0 has no such flag and never escapes U+2028/U+2029 when Unicode is unescaped.
    $terminators = defined('JSON_UNESCAPED_LINE_TERMINATORS') ? JSON_UNESCAPED_LINE_TERMINATORS : 0;
    return strlen(wp_json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | $terminators)) > 32768;
}

function raditi_content_row($id) {
    global $wpdb;
    $result = raditi_content_sql($wpdb->prepare("SELECT ID, post_type, post_status, post_password, post_title, post_content, post_excerpt FROM {$wpdb->posts} WHERE ID = %d FOR UPDATE", $id));
    if (!$result instanceof mysqli_result) { return false; }
    $row = mysqli_fetch_object($result);
    mysqli_free_result($result);
    return $row;
}

// The platform owns the deadline and sends how much of it is left. Measure only the time
// this request has spent here: this server's clock is never compared with the platform's.
function raditi_content_elapsed_ms() {
    return (int) floor((microtime(true) - (float) $_SERVER['REQUEST_TIME_FLOAT']) * 1000);
}

function raditi_content_filter($field, $value) {
    return $field === 'title' ? sanitize_text_field($value) : wp_kses_post($value);
}

// The declarations of a style value without the spelling of their separators: split at the
// semicolons outside strings and brackets, trimmed of CSS whitespace, empty ones dropped.
// Nothing inside a declaration is touched: the filter deletes tabs and line breaks there
// ("0<TAB>auto" becomes "0auto"), and that must stay a visible difference.
function raditi_content_style($style) {
    $declarations = array();
    $declaration = '';
    $quote = '';
    $depth = 0;
    for ($index = 0, $length = strlen($style); $index < $length; $index++) {
        $char = $style[$index];
        if ($char === '\\') { $declaration .= $char . ($style[++$index] ?? ''); continue; }
        if ($quote !== '') { if ($char === $quote) { $quote = ''; } }
        elseif ($char === '"' || $char === "'") { $quote = $char; }
        elseif ($char === '(' || $char === '[' || $char === '{') { $depth++; }
        elseif ($char === ')' || $char === ']' || $char === '}') { $depth = max(0, $depth - 1); }
        elseif ($char === ';' && $depth === 0) { $declarations[] = trim($declaration, " \t\n\r\f"); $declaration = ''; continue; }
        $declaration .= $char;
    }
    $declarations[] = trim($declaration, " \t\n\r\f");
    return implode(';', array_filter($declarations, 'strlen'));
}

// What a fragment means to a browser: its tags, attributes and decoded text, without the
// spelling the filter rewrites (quotes, " />", entities, the separators of a style value).
// An unfinished token, or WordPress before 6.5, leaves only identical bytes equal.
function raditi_content_markup($html) {
    if (!method_exists('WP_HTML_Tag_Processor', 'next_token')) { return $html; }
    $processor = new WP_HTML_Tag_Processor($html);
    $tokens = array();
    $text = '';
    while ($processor->next_token()) {
        if ($processor->get_token_type() === '#text') { $text .= $processor->get_modifiable_text(); continue; }
        if ($text !== '') { $tokens[] = $text; $text = ''; }
        $attributes = array();
        foreach ((array) $processor->get_attribute_names_with_prefix('') as $name) {
            $value = $processor->get_attribute($name);
            if ($name === 'style' && is_string($value)) { $value = raditi_content_style($value); }
            $attributes[$name] = $value;
        }
        $tokens[] = array($processor->get_token_type(), $processor->is_tag_closer(), $processor->get_token_name(), $attributes, $processor->get_modifiable_text());
    }
    if ($processor->paused_at_incomplete_token()) { return $html; }
    if ($text !== '') { $tokens[] = $text; }
    return $tokens;
}

function raditi_content_read($request) {
    global $wpdb;
    $id = (int) $request['id'];
    if (!current_user_can('edit_post', $id)) { return raditi_content_rejected('invalid'); }
    $state = raditi_content_state($wpdb->get_row($wpdb->prepare(
        "SELECT ID, post_type, post_status, post_password, post_title, post_content, post_excerpt FROM {$wpdb->posts} WHERE ID = %d", $id)));
    if (!$state) { return raditi_content_rejected('invalid'); }
    if (raditi_content_too_large($state)) { return raditi_content_rejected('invalid', 'size'); }
    return new WP_REST_Response($state, 200);
}

function raditi_content_operation($request) {
    global $wpdb;
    $call = (string) $request['call'];
    if (!raditi_content_uuid($call)) { return raditi_content_rejected('invalid'); }
    $encoded = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
        'raditi_content_call_' . $call));
    if ($encoded === null) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 200); }
    $record = json_decode($encoded, true);
    if (!is_array($record) || !isset($record['proof'])) { return raditi_content_rejected('unavailable'); }
    if ($record['proof']['kind'] === 'not_committed') { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 200); }
    return new WP_REST_Response($record['proof'], 200);
}

function raditi_content_operation_ref($request) {
    $input = $request->get_json_params();
    // deadlineAt only identifies the operation; ttlMs is what remains of it on the platform clock.
    $required = array('callId', 'siteId', 'epoch', 'requestHash', 'objectRef', 'deadlineAt', 'ttlMs');
    if (!is_array($input) || count($input) !== count($required) || array_diff($required, array_keys($input))
        || !raditi_content_uuid($input['callId']) || $input['callId'] !== $request['call']
        || $input['siteId'] !== get_option('raditi_content_site_id', '')
        || !is_int($input['epoch']) || $input['epoch'] < 1 || $input['epoch'] > 2147483647
        || !is_int($input['deadlineAt']) || $input['deadlineAt'] < 1 || !is_int($input['ttlMs'])
        || !is_string($input['requestHash']) || !preg_match('/^[a-f0-9]{64}$/D', $input['requestHash'])
        || !is_string($input['objectRef']) || !preg_match('/^(post|page):[1-9][0-9]{0,9}$/D', $input['objectRef'])) { return null; }
    return $input;
}

function raditi_content_matches_operation($proof, $input) {
    if (!is_array($proof)) { return false; }
    foreach (array('callId', 'siteId', 'epoch', 'requestHash', 'objectRef') as $key) {
        if (!isset($proof[$key]) || $proof[$key] !== $input[$key]) { return false; }
    }
    return true;
}

function raditi_content_reconcile($request) {
    global $wpdb;
    $input = raditi_content_operation_ref($request);
    if (!$input || (!current_user_can('manage_options')
        && !current_user_can('edit_post', (int) explode(':', $input['objectRef'])[1]))) { return raditi_content_rejected('invalid'); }
    $engine = $wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $wpdb->options));
    if (strtolower((string) $engine) !== 'innodb') { return raditi_content_rejected('unavailable'); }
    if (raditi_content_sql('START TRANSACTION') === false) { return raditi_content_rejected('unavailable'); }
    $committed = false;
    try {
        if (raditi_content_sql($wpdb->prepare("INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '0', 'no')", 'raditi_content_epoch')) === false
            || raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", 'raditi_content_epoch')) === null) {
            return raditi_content_rejected('unavailable');
        }
        // This lock also waits for an already dispatched writer to commit or roll back.
        $key = 'raditi_content_call_' . $input['callId'];
        $prior = raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $key));
        if ($prior !== null) {
            $record = json_decode($prior, true);
            if (!is_array($record) || !isset($record['proof']) || !raditi_content_matches_operation($record['proof'], $input)
                || ($record['proof']['kind'] === 'not_committed' && $record['proof']['deadlineAt'] !== $input['deadlineAt'])) {
                return raditi_content_rejected('conflict');
            }
            return new WP_REST_Response($record['proof'], 200);
        }
        // Do not cancel an active request merely because a read currently sees no receipt.
        if ($input['ttlMs'] > 0) {
            return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 200);
        }
        $proof = array_merge(array('version' => 1, 'kind' => 'not_committed'), array_diff_key($input, array('ttlMs' => 0)));
        if (raditi_content_sql($wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')", $key,
            wp_json_encode(array('proof' => $proof, 'deadlineAt' => $input['deadlineAt'])))) === false) { return raditi_content_rejected('unavailable'); }
        if (raditi_content_sql('COMMIT') === false) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503); }
        $committed = true;
        return new WP_REST_Response($proof, 200);
    } finally {
        if (!$committed) { raditi_content_sql('ROLLBACK'); }
    }
}

function raditi_content_forget($request) {
    global $wpdb;
    $input = raditi_content_operation_ref($request);
    // Only the trusted host, using an administrator connection, can retire a receipt.
    if (!$input || !current_user_can('manage_options')) { return raditi_content_rejected('invalid'); }
    $engine = $wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $wpdb->options));
    if (strtolower((string) $engine) !== 'innodb') { return raditi_content_rejected('unavailable'); }
    if (raditi_content_sql('START TRANSACTION') === false) { return raditi_content_rejected('unavailable'); }
    $committed = false;
    try {
        // A site whose writes were all refused before their transaction has no fence row yet.
        if (raditi_content_sql($wpdb->prepare("INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '0', 'no')", 'raditi_content_epoch')) === false) {
            return raditi_content_rejected('unavailable');
        }
        $epoch = raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", 'raditi_content_epoch'));
        if ($epoch === null) { return raditi_content_rejected('unavailable'); }
        // Until the platform's deadline has passed, the original dispatch may still arrive and
        // needs its receipt.
        if ($input['ttlMs'] > 0) { return raditi_content_rejected('fenced'); }
        $key = 'raditi_content_call_' . $input['callId'];
        $prior = raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $key));
        if ($prior !== null) {
            $record = json_decode($prior, true);
            if (!is_array($record) || !isset($record['proof'], $record['deadlineAt'])
                || !raditi_content_matches_operation($record['proof'], $input) || $record['deadlineAt'] !== $input['deadlineAt']) {
                return raditi_content_rejected('conflict');
            }
            if (raditi_content_sql($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name = %s", $key)) === false) {
                return raditi_content_rejected('unavailable');
            }
        }
        // Without its receipt nothing would stop the original dispatch if it still arrived: the
        // time it has left is its own claim, not this server's clock. Move the fence past its
        // epoch. That epoch has no writer any more, and every later one is higher.
        if ((int) $epoch <= $input['epoch'] && raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s",
            (string) min(2147483647, $input['epoch'] + 1), 'raditi_content_epoch')) === false) {
            return raditi_content_rejected('unavailable');
        }
        if (raditi_content_sql('COMMIT') === false) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503); }
        $committed = true;
        return new WP_REST_Response(array('version' => 1, 'kind' => 'forgotten', 'callId' => $input['callId']), 200);
    } finally {
        if (!$committed) { raditi_content_sql('ROLLBACK'); }
    }
}

function raditi_content_write($request) {
    global $wpdb;
    $input = $request->get_json_params();
    $required = array('callId', 'siteId', 'epoch', 'requestHash', 'objectRef', 'expectedStateHash', 'deadlineAt', 'mode', 'fields', 'ttlMs');
    if (!is_array($input) || count($input) !== count($required) || array_diff($required, array_keys($input))
        || !raditi_content_uuid($input['callId']) || $input['siteId'] !== get_option('raditi_content_site_id', '')
        || !is_int($input['epoch']) || $input['epoch'] < 1 || $input['epoch'] > 2147483647
        || !is_int($input['deadlineAt']) || $input['deadlineAt'] < 1 || !is_int($input['ttlMs'])
        || !is_string($input['requestHash']) || !preg_match('/^[a-f0-9]{64}$/D', $input['requestHash'])
        || !is_string($input['expectedStateHash']) || !preg_match('/^[a-f0-9]{64}$/D', $input['expectedStateHash'])
        || !is_string($input['objectRef']) || !preg_match('/^(post|page):[1-9][0-9]{0,9}$/D', $input['objectRef'])
        || !in_array($input['mode'], array('edit', 'restore'), true)
        || !is_array($input['fields']) || count($input['fields']) < 1
        || array_diff(array_keys($input['fields']), array('title', 'content', 'excerpt'))) {
        return raditi_content_rejected('invalid');
    }
    $bytes = 0;
    foreach ($input['fields'] as $value) {
        if (!is_string($value) || strpos($value, "\0") !== false) { return raditi_content_rejected('invalid'); }
        $bytes += strlen($value);
    }
    $id = (int) $request['id'];
    if (!current_user_can('edit_post', $id)) { return raditi_content_rejected('invalid'); }
    if ($bytes > 32768) { return raditi_content_rejected('invalid', 'size'); }
    // START TRANSACTION cannot fence a non-transactional table. Fail before changing anything.
    foreach (array($wpdb->posts, $wpdb->options) as $table) {
        $engine = $wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table));
        if (strtolower((string) $engine) !== 'innodb') { return raditi_content_rejected('unavailable'); }
    }
    // A replay is the same operation with less time left.
    $digest = hash('sha256', wp_json_encode(array_diff_key($input, array('ttlMs' => 0))));
    $key = 'raditi_content_call_' . $input['callId'];
    if (raditi_content_sql('START TRANSACTION') === false) { return raditi_content_rejected('unavailable'); }
    $committed = false;
    try {
        if (raditi_content_sql($wpdb->prepare("INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '0', 'no')", 'raditi_content_epoch')) === false) {
            return raditi_content_rejected('unavailable');
        }
        $epoch = raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", 'raditi_content_epoch'));
        if ($epoch === null) { return raditi_content_rejected('unavailable'); }
        $prior = raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $key));
        if ($prior !== null) {
            $record = json_decode($prior, true);
            if (is_array($record) && isset($record['proof']['kind']) && $record['proof']['kind'] === 'not_committed') {
                return raditi_content_rejected('fenced');
            }
            if (!is_array($record) || !isset($record['digest'], $record['proof']) || !hash_equals($record['digest'], $digest)) {
                return raditi_content_rejected('conflict');
            }
            return new WP_REST_Response($record['proof'], 200);
        }
        // The fence is shared by every post and page, not owned by an individual author.
        if ($input['epoch'] > (int) $epoch && !current_user_can('manage_options')) {
            return raditi_content_rejected('invalid');
        }
        if ((int) $epoch > $input['epoch'] || $input['ttlMs'] <= raditi_content_elapsed_ms()) {
            return raditi_content_rejected('fenced');
        }
        $row = raditi_content_row($id);
        if ($row === false) { return raditi_content_rejected('unavailable'); }
        $before = raditi_content_state($row);
        if (!$before || $before['objectRef'] !== $input['objectRef'] || !hash_equals($before['stateHash'], $input['expectedStateHash'])) {
            return raditi_content_rejected('conflict');
        }
        $raw = current_user_can('unfiltered_html');
        $update = array();
        foreach ($input['fields'] as $field => $value) {
            $stored = $row->{'post_' . $field};
            // A field that already holds this value is not rewritten and needs no HTML permission.
            if ($value === $stored) { continue; }
            $filtered = raditi_content_filter($field, $value);
            if ($input['mode'] === 'restore') {
                // Restoring a snapshot must not grant HTML permissions the caller does not have.
                // Reject unsafe originals rather than silently changing an exact restore.
                if (!$raw && $filtered !== $value) { return raditi_content_rejected('invalid', 'markup'); }
            } else {
                // Agent text is always stored filtered, and the filter must not cost the page
                // anything: neither markup in the new value, nor markup in the replaced one that
                // no edit could write back. Without unfiltered_html the replaced value must also
                // pass the restore check above, or this edit could not be undone.
                $kept = raditi_content_filter($field, $stored);
                if (raditi_content_markup($filtered) !== raditi_content_markup($value)
                    || ($raw ? raditi_content_markup($kept) !== raditi_content_markup($stored) : $kept !== $stored)) {
                    return raditi_content_rejected('invalid', 'markup');
                }
                $value = $filtered;
            }
            $row->{'post_' . $field} = $value;
            $update['post_' . $field] = $value;
        }
        $after = raditi_content_state($row);
        if (raditi_content_too_large($after)) { return raditi_content_rejected('invalid', 'size'); }
        $update['post_modified'] = current_time('mysql');
        $update['post_modified_gmt'] = current_time('mysql', true);
        $assignments = array();
        foreach ($update as $column => $value) { $assignments[] = $wpdb->prepare("$column = %s", $value); }
        if (raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->posts} SET " . implode(', ', $assignments) . ' WHERE ID = %d', $id)) === false
            || raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s", (string) $input['epoch'], 'raditi_content_epoch')) === false) {
            return raditi_content_rejected('unavailable');
        }
        // This UPDATE bypasses wpdb, and a database may store other text than it was sent (a
        // column charset without four-byte characters only warns). Read the row back: no
        // receipt is issued for a state the site does not hold.
        $saved = raditi_content_row($id);
        if ($saved === false) { return raditi_content_rejected('unavailable'); }
        $saved = raditi_content_state($saved);
        if (!$saved || !hash_equals($after['stateHash'], $saved['stateHash'])) { return raditi_content_rejected('invalid', 'storage'); }
        $proof = array('version' => 1, 'kind' => 'committed', 'callId' => $input['callId'],
            'siteId' => $input['siteId'], 'epoch' => $input['epoch'], 'requestHash' => $input['requestHash'],
            'objectRef' => $input['objectRef'], 'stateHash' => $after['stateHash']);
        if (raditi_content_sql($wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')", $key,
            wp_json_encode(array('digest' => $digest, 'proof' => $proof, 'deadlineAt' => $input['deadlineAt'])))) === false) {
            return raditi_content_rejected('unavailable');
        }
        if ($input['ttlMs'] <= raditi_content_elapsed_ms()) { return raditi_content_rejected('fenced'); }
        // A failed COMMIT has an uncertain result. Never label it as a proven rejection.
        if (raditi_content_sql('COMMIT') === false) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503); }
        $committed = true;
        clean_post_cache($id);
        return new WP_REST_Response($proof, 200);
    } finally {
        if (!$committed) { raditi_content_sql('ROLLBACK'); }
    }
}

add_action('rest_api_init', function () {
    register_rest_route('raditi/v1', '/content/(?P<id>[1-9][0-9]{0,9})', array(
        array('methods' => 'GET', 'callback' => 'raditi_content_read', 'permission_callback' => 'raditi_content_permission'),
        array('methods' => 'POST', 'callback' => 'raditi_content_write', 'permission_callback' => 'raditi_content_permission'),
    ));
    register_rest_route('raditi/v1', '/operations/(?P<call>[a-f0-9-]{36})', array(
        'methods' => 'GET', 'callback' => 'raditi_content_operation', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/operations/(?P<call>[a-f0-9-]{36})/reconcile', array(
        'methods' => 'POST', 'callback' => 'raditi_content_reconcile', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/operations/(?P<call>[a-f0-9-]{36})/forget', array(
        'methods' => 'POST', 'callback' => 'raditi_content_forget', 'permission_callback' => 'raditi_content_permission',
    ));
});
