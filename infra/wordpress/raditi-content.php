<?php
/**
 * Plugin Name: Raditi bounded published content
 * Description: The title, content and excerpt of public posts and pages; version 2 adds the
 * objects of a database plan (docs/plan/53-chat-preview-release.md, «Операции БД и миграции»):
 * a closed list of settings, records the platform creates, and tables of the platform made and
 * extended by a closed dictionary. Save hooks, builders, revisions and arbitrary REST data are
 * deliberately bypassed; nothing removes a record or a table of the site.
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

// The mark of a record the platform created (`_raditi_create`: the call that created it), or null.
function raditi_content_created_mark($id) {
    global $wpdb;
    return raditi_content_sql_value($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s ORDER BY meta_id LIMIT 1",
        $id, '_raditi_create'));
}

// Values in a row, each as <bytes>:<value>: the platform frames its hashes the same way.
function raditi_content_frames($values) {
    $material = '';
    foreach ($values as $value) { $material .= strlen($value) . ':' . $value; }
    return $material;
}

// A published post or page without a password, or a draft the platform created. The status takes
// the third frame of the hash, where version 1 wrote 'publish': a published record keeps its hash.
function raditi_content_state($row) {
    if (!$row || !in_array($row->post_type, array('post', 'page'), true) || $row->post_password !== '') { return null; }
    $status = (string) $row->post_status;
    if ($status !== 'publish' && !($status === 'draft' && raditi_content_created_mark((int) $row->ID) !== null)) { return null; }
    $state = array('version' => 1, 'objectRef' => $row->post_type . ':' . $row->ID,
        'kind' => $row->post_type, 'status' => $status, 'slug' => (string) $row->post_name,
        'title' => $row->post_title, 'content' => $row->post_content, 'excerpt' => $row->post_excerpt);
    $state['stateHash'] = hash('sha256', raditi_content_frames(array($state['objectRef'], $state['kind'], $status, '',
        $state['title'], $state['content'], $state['excerpt'])));
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
    $result = raditi_content_sql($wpdb->prepare("SELECT ID, post_type, post_status, post_password, post_name, post_title, post_content, post_excerpt FROM {$wpdb->posts} WHERE ID = %d FOR UPDATE", $id));
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
        "SELECT ID, post_type, post_status, post_password, post_name, post_title, post_content, post_excerpt FROM {$wpdb->posts} WHERE ID = %d", $id)));
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
        || !is_string($input['objectRef']) || !raditi_content_object_ref($input['objectRef'])) { return null; }
    return $input;
}

// A reference of any object a receipt names: a record, a setting of the list, a table of the platform.
function raditi_content_object_ref($ref) {
    return is_string($ref) && (preg_match('/^(post|page):[1-9][0-9]{0,9}$/D', $ref)
        || (preg_match('/^option:([a-z][a-z0-9_]{0,63})$/D', $ref, $match) && isset(raditi_content_settings()[$match[1]]))
        || preg_match('/^table:[a-z][a-z0-9_]{0,29}$/D', $ref));
}

// Whether this connection may act on the object of a receipt: an administrator on any, an editor
// on a record it may edit.
function raditi_content_may_reconcile($ref) {
    if (current_user_can('manage_options')) { return true; }
    return preg_match('/^(post|page):([1-9][0-9]{0,9})$/D', $ref, $match) && current_user_can('edit_post', (int) $match[2]);
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
    if (!$input || !raditi_content_may_reconcile($input['objectRef'])) { return raditi_content_rejected('invalid'); }
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
        // Do not cancel an active request merely because a read currently sees no receipt. A
        // table is changed by a statement that no transaction holds: no negative proof stops one
        // still waiting for its lock, so its outcome is only ever read from its state.
        if ($input['ttlMs'] > 0 || strpos($input['objectRef'], 'table:') === 0) {
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
        || !in_array($input['mode'], array('edit', 'restore', 'release'), true)
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
            } elseif ($input['mode'] === 'release') {
                // A value a release carries from a preview: the preview runs the agent's code, so
                // what its copy of this plugin stored proves nothing about the filter. Exact bytes,
                // and only bytes the filter keeps as they are, whoever writes — unfiltered_html or not.
                if ($filtered !== $value) { return raditi_content_rejected('invalid', 'markup'); }
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

// The code cache of this server's PHP (opcache), for a release (stand R12): a release checks the
// site only once the code it wrote is the code the site runs. Whether a cache is on, whether it
// looks at the time of a file and how often, and whether this plugin may drop a file from it —
// tried on the plugin's own file, unchanged, which a cache drops only if it changed; false when
// the API is restricted (opcache.restrict_api), disabled or the cache is off.
function raditi_content_code_cache_state() {
    $enabled = extension_loaded('Zend OPcache')
        && filter_var(ini_get(PHP_SAPI === 'cli' ? 'opcache.enable_cli' : 'opcache.enable'), FILTER_VALIDATE_BOOLEAN);
    $refresh = $enabled && function_exists('opcache_invalidate') && @opcache_invalidate(__FILE__, false) === true;
    return array('version' => 1, 'kind' => 'code_cache', 'enabled' => $enabled,
        'validateTimestamps' => $enabled ? filter_var(ini_get('opcache.validate_timestamps'), FILTER_VALIDATE_BOOLEAN) : true,
        'revalidateSeconds' => $enabled ? min(31536000, max(0, (int) ini_get('opcache.revalidate_freq'))) : 0,
        'refresh' => $refresh);
}

function raditi_content_code_cache($request) {
    return new WP_REST_Response(raditi_content_code_cache_state(), 200);
}

// Drops the named files — paths from the root of the site, at most 1000 — from the cache. A path
// that is not in the tree (a file the release deleted) is `absent`: there is nothing to run. A
// path outside the root, or through a link that leads out of it, refuses the whole request.
function raditi_content_code_cache_refresh($request) {
    $input = $request->get_json_params();
    $paths = is_array($input) && ($input['version'] ?? null) === 1 && isset($input['paths']) ? $input['paths'] : null;
    if (!is_array($paths) || count($paths) < 1 || count($paths) > 1000) { return raditi_content_rejected('invalid'); }
    $root = realpath(ABSPATH);
    if ($root === false) { return raditi_content_rejected('unavailable'); }
    foreach ($paths as $path) {
        if (!is_string($path) || $path === '' || strlen($path) > 1024 || strpbrk($path, "\\\0") !== false) { return raditi_content_rejected('invalid'); }
        foreach (explode('/', $path) as $segment) {
            if ($segment === '' || $segment === '.' || $segment === '..') { return raditi_content_rejected('invalid'); }
        }
    }
    $state = raditi_content_code_cache_state();
    $counts = array('refreshed' => 0, 'absent' => 0, 'failed' => 0);
    foreach ($paths as $path) {
        $full = realpath($root . DIRECTORY_SEPARATOR . $path);
        if ($full === false) { $counts['absent']++; continue; }
        if (strpos($full, $root . DIRECTORY_SEPARATOR) !== 0) { return raditi_content_rejected('invalid'); }
        if (!$state['enabled']) { $counts['refreshed']++; continue; }
        if ($state['refresh'] && @opcache_invalidate($full, true) === true) { $counts['refreshed']++; } else { $counts['failed']++; }
    }
    return new WP_REST_Response(array('version' => 1, 'kind' => 'code_cache_refreshed') + $counts, 200);
}

// What this server runs (plan 53, Р2, Р18): the version of PHP and its loaded extensions, so a
// preview of the site runs on the closest PHP its host has and says what it lacks. Names only.
function raditi_content_runtime($request) {
    $extensions = array();
    foreach (get_loaded_extensions() as $name) {
        $name = strtolower((string) $name);
        if (preg_match('/^[a-z0-9][a-z0-9_ .+-]{0,62}$/D', $name)) { $extensions[$name] = true; }
    }
    $extensions = array_keys($extensions);
    sort($extensions, SORT_STRING);
    return new WP_REST_Response(array('version' => 1, 'kind' => 'runtime',
        'runtimeVersion' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
        'extensions' => array_slice($extensions, 0, 256)), 200);
}

// ─── Version 2: the objects of a database plan (docs/plan/53, «Операции БД и миграции») ─────────

if (!defined('RADITI_CONTENT_PLUGIN')) { define('RADITI_CONTENT_PLUGIN', 2); }
// The ids the platform gives records it creates in a preview: production's own stay below.
if (!defined('RADITI_CREATED_ID_BASE')) { define('RADITI_CREATED_ID_BASE', 1000000000); }
if (!defined('RADITI_CREATED_ID_MAX')) { define('RADITI_CREATED_ID_MAX', 9999999999); }

// The settings a plan may change, by their names in the database: the kind of the value, and for
// a text its bytes and the characters it may not hold, for an integer its range. The same list as
// wordpressDbSettings of @repo/site-adapters (a test compares them). No other is read or written.
function raditi_content_settings() {
    return array(
        'blogname' => array('text', 200, ''),
        'blogdescription' => array('text', 500, ''),
        'date_format' => array('text', 64, '<>'),
        'time_format' => array('text', 64, '<>'),
        'start_of_week' => array('integer', 0, 6),
        'posts_per_page' => array('integer', 1, 100),
    );
}

function raditi_content_setting_allowed($rule, $value) {
    if (!is_string($value) || preg_match('/\p{Cc}/u', $value) !== 0) { return false; }
    if ($rule[0] === 'integer') {
        return preg_match('/^-?(0|[1-9][0-9]{0,9})$/D', $value) === 1 && $value !== '-0'
            && (int) $value >= $rule[1] && (int) $value <= $rule[2];
    }
    if (strlen($value) > $rule[1]) { return false; }
    for ($at = 0; $at < strlen($rule[2]); $at++) {
        if (strpos($value, $rule[2][$at]) !== false) { return false; }
    }
    return true;
}

function raditi_content_sql_rows($query) {
    $result = raditi_content_sql($query);
    if (!$result instanceof mysqli_result) { return false; }
    $rows = array();
    while ($row = mysqli_fetch_assoc($result)) { $rows[] = $row; }
    mysqli_free_result($result);
    return $rows;
}

function raditi_content_innodb($tables) {
    global $wpdb;
    foreach ($tables as $table) {
        $engine = $wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table));
        if (strtolower((string) $engine) !== 'innodb') { return false; }
    }
    return true;
}

function raditi_content_absent_state($ref) {
    return array('version' => 1, 'objectRef' => $ref, 'absent' => true,
        'stateHash' => hash('sha256', raditi_content_frames(array('absent', $ref))));
}

// The raw value of a setting, never through get_option: the filters of the site do not change it.
function raditi_content_option_state($name, $lock = false) {
    global $wpdb;
    $rows = raditi_content_sql_rows($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s" . ($lock ? ' FOR UPDATE' : ''), $name));
    if ($rows === false) { return false; }
    $value = $rows ? (string) $rows[0]['option_value'] : null;
    $ref = 'option:' . $name;
    return array('version' => 1, 'objectRef' => $ref, 'value' => $value,
        'stateHash' => hash('sha256', raditi_content_frames(array('option', $ref, $value === null ? '0' : '1', (string) $value))));
}

// A record by its type and id: its state, absent (no row, or a record of the platform in the
// trash), or null — there and not readable here. false — the database did not answer.
function raditi_content_record_object($type, $id, $lock = false) {
    global $wpdb;
    $result = raditi_content_sql($wpdb->prepare("SELECT ID, post_type, post_status, post_password, post_name, post_title, post_content, post_excerpt FROM {$wpdb->posts} WHERE ID = %d" . ($lock ? ' FOR UPDATE' : ''), $id));
    if (!$result instanceof mysqli_result) { return false; }
    $row = mysqli_fetch_object($result);
    mysqli_free_result($result);
    $ref = $type . ':' . $id;
    if (!$row || ($row->post_type === $type && $row->post_status === 'trash' && raditi_content_created_mark($id) !== null)) {
        return array('row' => $row ?: null, 'state' => raditi_content_absent_state($ref));
    }
    return array('row' => $row, 'state' => $row->post_type === $type ? raditi_content_state($row) : null);
}

// The fields every write of an object of a plan carries, and its own besides them.
function raditi_content_db_input($request, $own) {
    $input = $request->get_json_params();
    $required = array_merge(array('callId', 'siteId', 'epoch', 'requestHash', 'objectRef', 'expectedStateHash', 'deadlineAt', 'ttlMs', 'mode'), $own);
    if (!is_array($input) || count($input) !== count($required) || array_diff($required, array_keys($input))
        || !raditi_content_uuid($input['callId']) || $input['siteId'] !== get_option('raditi_content_site_id', '')
        || !is_int($input['epoch']) || $input['epoch'] < 1 || $input['epoch'] > 2147483647
        || !is_int($input['deadlineAt']) || $input['deadlineAt'] < 1 || !is_int($input['ttlMs'])
        || !is_string($input['requestHash']) || !preg_match('/^[a-f0-9]{64}$/D', $input['requestHash'])
        || !is_string($input['expectedStateHash']) || !preg_match('/^[a-f0-9]{64}$/D', $input['expectedStateHash'])
        || !raditi_content_object_ref($input['objectRef'])
        || !in_array($input['mode'], array('edit', 'restore', 'release'), true)) { return null; }
    return $input;
}

function raditi_content_db_digest($input) {
    return hash('sha256', wp_json_encode(array_diff_key($input, array('ttlMs' => 0))));
}

// The start of every write under the fence, as for published content: the epoch row locked, a
// repeated call answered by its receipt, the epoch and the time left checked. null — go on in the
// open transaction; anything else is the answer (the caller rolls back).
function raditi_content_db_begin($input, $digest) {
    global $wpdb;
    if (raditi_content_sql('START TRANSACTION') === false) { return raditi_content_rejected('unavailable'); }
    if (raditi_content_sql($wpdb->prepare("INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '0', 'no')", 'raditi_content_epoch')) === false) {
        return raditi_content_rejected('unavailable');
    }
    $epoch = raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", 'raditi_content_epoch'));
    if ($epoch === null) { return raditi_content_rejected('unavailable'); }
    $prior = raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", 'raditi_content_call_' . $input['callId']));
    if ($prior !== null) {
        $record = json_decode($prior, true);
        if (is_array($record) && isset($record['proof']['kind']) && $record['proof']['kind'] === 'not_committed') { return raditi_content_rejected('fenced'); }
        if (!is_array($record) || !isset($record['digest'], $record['proof']) || !hash_equals($record['digest'], $digest)) { return raditi_content_rejected('conflict'); }
        return new WP_REST_Response($record['proof'], 200);
    }
    if ($input['epoch'] > (int) $epoch && !current_user_can('manage_options')) { return raditi_content_rejected('invalid'); }
    if ((int) $epoch > $input['epoch'] || $input['ttlMs'] <= raditi_content_elapsed_ms()) { return raditi_content_rejected('fenced'); }
    return null;
}

function raditi_content_db_proof($input, $state_hash, $created_ref = null) {
    $proof = array('version' => 1, 'kind' => 'committed', 'callId' => $input['callId'],
        'siteId' => $input['siteId'], 'epoch' => $input['epoch'], 'requestHash' => $input['requestHash'],
        'objectRef' => $input['objectRef'], 'stateHash' => $state_hash);
    if ($created_ref !== null) { $proof['createdRef'] = $created_ref; }
    return $proof;
}

// The end of a write: the fence moved to its epoch, its receipt kept with it, one COMMIT. true —
// committed; anything else is the answer.
function raditi_content_db_commit($input, $digest, $proof) {
    global $wpdb;
    if (raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s", (string) $input['epoch'], 'raditi_content_epoch')) === false
        || raditi_content_sql($wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')", 'raditi_content_call_' . $input['callId'],
            wp_json_encode(array('digest' => $digest, 'proof' => $proof, 'deadlineAt' => $input['deadlineAt'])))) === false) {
        return raditi_content_rejected('unavailable');
    }
    if ($input['ttlMs'] <= raditi_content_elapsed_ms()) { return raditi_content_rejected('fenced'); }
    if (raditi_content_sql('COMMIT') === false) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503); }
    return true;
}

// What this plugin can write here with the rights of its connection; a preview also says the
// lowest free id from the base — the platform takes it as a floor, never as the id itself.
function raditi_content_capabilities($request) {
    global $wpdb;
    $admin = current_user_can('manage_options');
    $operations = array('content_update');
    if ($admin) { $operations[] = 'option_update'; }
    if (current_user_can('publish_posts') && current_user_can('publish_pages')) { $operations[] = 'post_create'; }
    $server = raditi_content_server();
    if ($admin && $server['instant']) { $operations[] = 'schema_migration'; }
    $max = (int) $wpdb->get_var("SELECT COALESCE(MAX(ID), 0) FROM {$wpdb->posts}");
    $body = array('version' => 1, 'kind' => 'capabilities', 'plugin' => RADITI_CONTENT_PLUGIN,
        'operations' => $operations, 'settings' => $admin ? array_keys(raditi_content_settings()) : array(),
        'maxRecordId' => min($max, RADITI_CREATED_ID_MAX));
    if (defined('RADITI_PREVIEW_ORIGIN') && $max < RADITI_CREATED_ID_MAX) {
        $body['nextCreatedId'] = max(RADITI_CREATED_ID_BASE, $max + 1);
    }
    return new WP_REST_Response($body, 200);
}

function raditi_content_record_read($request) {
    $type = (string) $request['type'];
    $id = (int) $request['id'];
    $found = raditi_content_record_object($type, $id);
    if ($found === false) { return raditi_content_rejected('unavailable'); }
    if ($found['state'] === null || (empty($found['state']['absent']) && !current_user_can('edit_post', $id))) { return raditi_content_rejected('invalid'); }
    if (raditi_content_too_large($found['state'])) { return raditi_content_rejected('invalid', 'size'); }
    return new WP_REST_Response($found['state'], 200);
}

// An address of a new record: lower-case Latin letters, digits and single hyphens, not digits
// alone, as sanitize_title leaves it.
function raditi_content_slug_valid($slug) {
    return is_string($slug) && strlen($slug) <= 200 && preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/D', $slug) === 1
        && preg_match('/^[0-9]+$/D', $slug) !== 1 && sanitize_title($slug) === $slug;
}

// Whether a record of `type` at this address would collide: WordPress's own rule for a published
// one (reserved words, archives, the filters plugins add), and a row of that name besides.
function raditi_content_slug_taken($type, $slug, $lock = false) {
    global $wpdb;
    if (!raditi_content_slug_valid($slug) || wp_unique_post_slug($slug, 0, 'publish', $type, 0) !== $slug) { return true; }
    $types = $type === 'page' ? "'page', 'attachment'" : "'post'";
    $rows = raditi_content_sql_rows($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE post_name = %s AND post_type IN ($types) AND post_status NOT IN ('trash', 'auto-draft', 'inherit') LIMIT 1" . ($lock ? ' FOR UPDATE' : ''), $slug));
    return $rows === false ? null : count($rows) > 0;
}

function raditi_content_slug($request) {
    $taken = raditi_content_slug_taken((string) $request['type'], (string) $request['slug']);
    if ($taken === null) { return raditi_content_rejected('unavailable'); }
    return new WP_REST_Response(array('version' => 1, 'kind' => 'slug', 'taken' => $taken), 200);
}

// A new record of a plan. Into a preview it gets the id of its reference (`edit` from the agent,
// `restore` from a rebuild): its reference holds over every rebuild. On production (`release`)
// the site gives it its own id, and the receipt says which. Its mark is the call that created it.
function raditi_content_record_create($request) {
    global $wpdb;
    $type = (string) $request['type'];
    $input = raditi_content_db_input($request, array('record', 'createCallId'));
    if (!$input || !preg_match('/^' . $type . ':([1-9][0-9]{9})$/D', $input['objectRef'], $match)
        || (int) $match[1] < RADITI_CREATED_ID_BASE || !raditi_content_uuid($input['createCallId'])
        || !is_array($input['record']) || count($input['record']) !== 5) {
        return raditi_content_rejected('invalid');
    }
    $record = $input['record'];
    foreach (array('status', 'slug', 'title', 'content', 'excerpt') as $key) {
        if (!isset($record[$key]) || !is_string($record[$key]) || strpos($record[$key], "\0") !== false) { return raditi_content_rejected('invalid'); }
    }
    $import = $input['mode'] !== 'release';
    // The id of a plan means nothing on production: only a preview stores a record under it.
    if (($import && !defined('RADITI_PREVIEW_ORIGIN')) || !in_array($record['status'], array('publish', 'draft'), true)) { return raditi_content_rejected('invalid'); }
    if (!raditi_content_slug_valid($record['slug'])) { return raditi_content_rejected('invalid', 'slug'); }
    $object = get_post_type_object($type);
    if (!$object || !current_user_can($record['status'] === 'publish' ? $object->cap->publish_posts : $object->cap->edit_posts)) { return raditi_content_rejected('invalid'); }
    if (!hash_equals(raditi_content_absent_state($input['objectRef'])['stateHash'], $input['expectedStateHash'])) { return raditi_content_rejected('conflict'); }
    if (strlen($record['title'] . $record['content'] . $record['excerpt']) > 32768) { return raditi_content_rejected('invalid', 'size'); }
    $raw = current_user_can('unfiltered_html');
    foreach (array('title', 'content', 'excerpt') as $field) {
        $value = $record[$field];
        $filtered = raditi_content_filter($field, $value);
        if ($input['mode'] === 'edit') {
            if (raditi_content_markup($filtered) !== raditi_content_markup($value)) { return raditi_content_rejected('invalid', 'markup'); }
            $record[$field] = $filtered;
        } elseif ($filtered !== $value && ($input['mode'] === 'release' || !$raw)) {
            return raditi_content_rejected('invalid', 'markup');
        }
    }
    if ($record['title'] === '') { return raditi_content_rejected('invalid'); }
    if (!raditi_content_innodb(array($wpdb->posts, $wpdb->postmeta, $wpdb->options))) { return raditi_content_rejected('unavailable'); }
    $digest = raditi_content_db_digest($input);
    $committed = false;
    try {
        $begun = raditi_content_db_begin($input, $digest);
        if ($begun !== null) { return $begun; }
        $id = $import ? (int) $match[1] : 0;
        if ($import) {
            $taken = raditi_content_sql_rows($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE ID = %d FOR UPDATE", $id));
            if ($taken === false) { return raditi_content_rejected('unavailable'); }
            if ($taken) { return raditi_content_rejected('conflict'); }
        }
        $collides = raditi_content_slug_taken($type, $record['slug'], true);
        if ($collides === null) { return raditi_content_rejected('unavailable'); }
        if ($collides) { return raditi_content_rejected('invalid', 'slug'); }
        $now = current_time('mysql');
        $gmt = current_time('mysql', true);
        $columns = array('post_author' => (string) get_current_user_id(), 'post_date' => $now, 'post_date_gmt' => $gmt,
            'post_content' => $record['content'], 'post_title' => $record['title'], 'post_excerpt' => $record['excerpt'],
            'post_status' => $record['status'], 'comment_status' => get_default_comment_status($type),
            'ping_status' => get_default_comment_status($type, 'pingback'), 'post_password' => '', 'post_name' => $record['slug'],
            'to_ping' => '', 'pinged' => '', 'post_modified' => $now, 'post_modified_gmt' => $gmt, 'post_content_filtered' => '',
            'post_parent' => '0', 'guid' => '', 'menu_order' => '0', 'post_type' => $type, 'post_mime_type' => '', 'comment_count' => '0');
        if ($import) { $columns = array('ID' => (string) $id) + $columns; }
        $values = array();
        foreach ($columns as $value) { $values[] = $wpdb->prepare('%s', $value); }
        if (raditi_content_sql("INSERT INTO {$wpdb->posts} (" . implode(', ', array_keys($columns)) . ') VALUES (' . implode(', ', $values) . ')') === false) {
            return raditi_content_rejected('unavailable');
        }
        if (!$import) { $id = (int) mysqli_insert_id($wpdb->dbh); }
        if ($id < 1 || (!$import && $id >= RADITI_CREATED_ID_BASE)
            || raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->posts} SET guid = %s WHERE ID = %d", home_url('/?' . ($type === 'page' ? 'page_id' : 'p') . '=' . $id), $id)) === false
            || raditi_content_sql($wpdb->prepare("INSERT INTO {$wpdb->postmeta} (post_id, meta_key, meta_value) VALUES (%d, %s, %s)", $id, '_raditi_create', $input['createCallId'])) === false) {
            return raditi_content_rejected('unavailable');
        }
        $created = $type . ':' . $id;
        $expected = hash('sha256', raditi_content_frames(array($created, $type, $record['status'], '', $record['title'], $record['content'], $record['excerpt'])));
        $saved = raditi_content_row($id);
        if ($saved === false) { return raditi_content_rejected('unavailable'); }
        $saved = raditi_content_state($saved);
        if (!$saved || !hash_equals($expected, $saved['stateHash'])) { return raditi_content_rejected('invalid', 'storage'); }
        if (raditi_content_too_large($saved)) { return raditi_content_rejected('invalid', 'size'); }
        $proof = raditi_content_db_proof($input, $saved['stateHash'], $created);
        $done = raditi_content_db_commit($input, $digest, $proof);
        if ($done !== true) { return $done; }
        $committed = true;
        clean_post_cache($id);
        return new WP_REST_Response($proof, 200);
    } finally {
        if (!$committed) { raditi_content_sql('ROLLBACK'); }
    }
}

// How many records of the site stand on a record: its comments of any status, the records below
// it (its revisions aside), the menu items that open it. WordPress empties its trash in its time,
// and takes those along with the record: the platform trashes none of its records that has them.
// false — the database did not answer.
function raditi_content_dependents($id) {
    global $wpdb;
    $comments = raditi_content_sql_value($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->comments} WHERE comment_post_ID = %d", $id));
    $children = raditi_content_sql_value($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_parent = %d AND post_type <> 'revision'", $id));
    $menus = raditi_content_sql_value($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->postmeta} m JOIN {$wpdb->postmeta} t ON t.post_id = m.post_id AND t.meta_key = '_menu_item_type' AND t.meta_value = 'post_type' WHERE m.meta_key = '_menu_item_object_id' AND m.meta_value = %s",
        (string) $id));
    if ($comments === null || $children === null || $menus === null) { return false; }
    return (int) $comments + (int) $children + (int) $menus;
}

function raditi_content_record_dependents($request) {
    $type = (string) $request['type'];
    $id = (int) $request['id'];
    $found = raditi_content_record_object($type, $id);
    if ($found === false) { return raditi_content_rejected('unavailable'); }
    if ($found['state'] === null || !empty($found['state']['absent']) || !current_user_can('edit_post', $id)) { return raditi_content_rejected('invalid'); }
    $count = raditi_content_dependents($id);
    if ($count === false) { return raditi_content_rejected('unavailable'); }
    return new WP_REST_Response(array('version' => 1, 'kind' => 'dependents', 'objectRef' => $type . ':' . $id, 'count' => $count), 200);
}

// A record of the platform to the trash, only while it holds what the caller wrote: its state
// hash, its address and its mark — and only while nothing of the site stands on it (its comments,
// records below it, menu items: the trash would take them along). The trash is WordPress's own:
// the address gets `__trashed`, the metadata of the trash is there, and WordPress removes it in
// its time.
function raditi_content_record_trash($request) {
    global $wpdb;
    $type = (string) $request['type'];
    $id = (int) $request['id'];
    $input = raditi_content_db_input($request, array('expectedSlug', 'createCallId'));
    if (!$input || $input['objectRef'] !== $type . ':' . $id || $input['mode'] !== 'restore'
        || !is_string($input['expectedSlug']) || !raditi_content_uuid($input['createCallId'])
        || !current_user_can('delete_post', $id)) {
        return raditi_content_rejected('invalid');
    }
    if (!raditi_content_innodb(array($wpdb->posts, $wpdb->postmeta, $wpdb->options))) { return raditi_content_rejected('unavailable'); }
    $digest = raditi_content_db_digest($input);
    $committed = false;
    try {
        $begun = raditi_content_db_begin($input, $digest);
        if ($begun !== null) { return $begun; }
        $found = raditi_content_record_object($type, $id, true);
        if ($found === false) { return raditi_content_rejected('unavailable'); }
        $state = $found['state'];
        if (!$state || !empty($state['absent']) || !hash_equals($state['stateHash'], $input['expectedStateHash'])
            || $found['row']->post_name !== $input['expectedSlug'] || raditi_content_created_mark($id) !== $input['createCallId']) {
            return raditi_content_rejected('conflict');
        }
        $dependents = raditi_content_dependents($id);
        if ($dependents === false) { return raditi_content_rejected('unavailable'); }
        if ($dependents > 0) { return raditi_content_rejected('conflict', 'dependents'); }
        $slug = (string) $found['row']->post_name;
        if (raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->posts} SET post_status = 'trash', post_name = %s WHERE ID = %d", substr($slug, 0, 191) . '__trashed', $id)) === false) {
            return raditi_content_rejected('unavailable');
        }
        foreach (array('_wp_trash_meta_status' => $state['status'], '_wp_trash_meta_time' => (string) time(), '_wp_desired_post_slug' => $slug) as $key => $value) {
            if (raditi_content_sql($wpdb->prepare("INSERT INTO {$wpdb->postmeta} (post_id, meta_key, meta_value) VALUES (%d, %s, %s)", $id, $key, $value)) === false) {
                return raditi_content_rejected('unavailable');
            }
        }
        $proof = raditi_content_db_proof($input, raditi_content_absent_state($input['objectRef'])['stateHash']);
        $done = raditi_content_db_commit($input, $digest, $proof);
        if ($done !== true) { return $done; }
        $committed = true;
        clean_post_cache($id);
        return new WP_REST_Response($proof, 200);
    } finally {
        if (!$committed) { raditi_content_sql('ROLLBACK'); }
    }
}

// A record of the platform that `trash` took to the trash comes back as it was — the rollback of
// an undo of a release (docs/plan/53, «Отмена выпуска»): only `restore`, only the record of that
// very mark from WordPress's trash, at the address it had while that address is still free.
function raditi_content_record_untrash($request) {
    global $wpdb;
    $type = (string) $request['type'];
    $id = (int) $request['id'];
    $input = raditi_content_db_input($request, array('expectedSlug', 'createCallId'));
    if (!$input || $input['objectRef'] !== $type . ':' . $id || $input['mode'] !== 'restore'
        || !raditi_content_slug_valid($input['expectedSlug']) || !raditi_content_uuid($input['createCallId'])
        || !current_user_can('delete_post', $id)) {
        return raditi_content_rejected('invalid');
    }
    if (!raditi_content_innodb(array($wpdb->posts, $wpdb->postmeta, $wpdb->options))) { return raditi_content_rejected('unavailable'); }
    $digest = raditi_content_db_digest($input);
    $committed = false;
    try {
        $begun = raditi_content_db_begin($input, $digest);
        if ($begun !== null) { return $begun; }
        $found = raditi_content_record_object($type, $id, true);
        if ($found === false) { return raditi_content_rejected('unavailable'); }
        $row = $found['row'];
        if (!$row || !$found['state'] || empty($found['state']['absent']) || $row->post_status !== 'trash'
            || !hash_equals($found['state']['stateHash'], $input['expectedStateHash'])
            || raditi_content_created_mark($id) !== $input['createCallId']) {
            return raditi_content_rejected('conflict');
        }
        $meta = raditi_content_sql_rows($wpdb->prepare("SELECT meta_key, meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key IN ('_wp_trash_meta_status', '_wp_desired_post_slug') FOR UPDATE", $id));
        if ($meta === false) { return raditi_content_rejected('unavailable'); }
        $kept = array();
        foreach ($meta as $item) { $kept[$item['meta_key']][] = (string) $item['meta_value']; }
        $status = isset($kept['_wp_trash_meta_status']) && count($kept['_wp_trash_meta_status']) === 1 ? $kept['_wp_trash_meta_status'][0] : null;
        $slug = isset($kept['_wp_desired_post_slug']) && count($kept['_wp_desired_post_slug']) === 1 ? $kept['_wp_desired_post_slug'][0] : null;
        if (!in_array($status, array('publish', 'draft'), true) || $slug !== $input['expectedSlug']) { return raditi_content_rejected('conflict'); }
        $collides = raditi_content_slug_taken($type, $slug, true);
        if ($collides === null) { return raditi_content_rejected('unavailable'); }
        if ($collides) { return raditi_content_rejected('conflict', 'slug'); }
        if (raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->posts} SET post_status = %s, post_name = %s WHERE ID = %d", $status, $slug, $id)) === false
            || raditi_content_sql($wpdb->prepare("DELETE FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key IN ('_wp_trash_meta_status', '_wp_trash_meta_time', '_wp_desired_post_slug')", $id)) === false) {
            return raditi_content_rejected('unavailable');
        }
        $saved = raditi_content_row($id);
        if ($saved === false) { return raditi_content_rejected('unavailable'); }
        $saved = raditi_content_state($saved);
        if (!$saved) { return raditi_content_rejected('invalid', 'storage'); }
        $proof = raditi_content_db_proof($input, $saved['stateHash']);
        $done = raditi_content_db_commit($input, $digest, $proof);
        if ($done !== true) { return $done; }
        $committed = true;
        clean_post_cache($id);
        return new WP_REST_Response($proof, 200);
    } finally {
        if (!$committed) { raditi_content_sql('ROLLBACK'); }
    }
}

function raditi_content_setting_read($request) {
    $name = (string) $request['option'];
    if (!isset(raditi_content_settings()[$name]) || !current_user_can('manage_options')) { return raditi_content_rejected('invalid'); }
    $state = raditi_content_option_state($name);
    if ($state === false) { return raditi_content_rejected('unavailable'); }
    return new WP_REST_Response($state, 200);
}

// A setting of the list: `edit` stores what sanitize_option makes of the agent's value, `release`
// only a value it keeps as it is, `restore` the exact bytes the site held (null: no row). Written
// in the database without the hooks of update_option, like the text of a record.
function raditi_content_setting_write($request) {
    global $wpdb;
    $name = (string) $request['option'];
    $rules = raditi_content_settings();
    if (!isset($rules[$name]) || !current_user_can('manage_options')) { return raditi_content_rejected('invalid'); }
    $input = raditi_content_db_input($request, array('value'));
    if (!$input || $input['objectRef'] !== 'option:' . $name) { return raditi_content_rejected('invalid'); }
    $value = $input['value'];
    if ($value === null ? $input['mode'] !== 'restore' : (!is_string($value) || strpos($value, "\0") !== false || strlen($value) > 32768)) {
        return raditi_content_rejected('invalid');
    }
    if ($input['mode'] === 'edit') {
        if (!raditi_content_setting_allowed($rules[$name], $value)) { return raditi_content_rejected('invalid'); }
        $value = (string) sanitize_option($name, $value);
        if (!raditi_content_setting_allowed($rules[$name], $value)) { return raditi_content_rejected('invalid', 'markup'); }
    } elseif ($input['mode'] === 'release'
        && (!raditi_content_setting_allowed($rules[$name], $value) || (string) sanitize_option($name, $value) !== $value)) {
        return raditi_content_rejected('invalid', 'markup');
    }
    if (!raditi_content_innodb(array($wpdb->options))) { return raditi_content_rejected('unavailable'); }
    $digest = raditi_content_db_digest($input);
    $committed = false;
    try {
        $begun = raditi_content_db_begin($input, $digest);
        if ($begun !== null) { return $begun; }
        $before = raditi_content_option_state($name, true);
        if ($before === false) { return raditi_content_rejected('unavailable'); }
        if (!hash_equals($before['stateHash'], $input['expectedStateHash'])) { return raditi_content_rejected('conflict'); }
        if ($value === null) {
            $written = raditi_content_sql($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name = %s", $name));
        } elseif ($before['value'] === null) {
            $written = raditi_content_sql($wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'yes')", $name, $value));
        } else {
            $written = raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s", $value, $name));
        }
        if ($written === false) { return raditi_content_rejected('unavailable'); }
        $after = raditi_content_option_state($name);
        if ($after === false) { return raditi_content_rejected('unavailable'); }
        if ($after['value'] !== $value) { return raditi_content_rejected('invalid', 'storage'); }
        $proof = raditi_content_db_proof($input, $after['stateHash']);
        $done = raditi_content_db_commit($input, $digest, $proof);
        if ($done !== true) { return $done; }
        $committed = true;
        wp_cache_delete('alloptions', 'options');
        wp_cache_delete('notoptions', 'options');
        wp_cache_delete($name, 'options');
        return new WP_REST_Response($proof, 200);
    } finally {
        if (!$committed) { raditi_content_sql('ROLLBACK'); }
    }
}

// ─── Tables of the platform ──────────────────────────────────────────────────────────────────

// The server's kind and whether it adds a column without copying the table (INSTANT: MySQL
// 8.0.12, MariaDB 10.3.2): a migration is offered only where it cannot hold the table long.
function raditi_content_server() {
    $version = (string) raditi_content_sql_value('SELECT VERSION()');
    $mariadb = stripos($version, 'mariadb') !== false;
    $number = 0;
    if (preg_match('/^(?:5\.5\.5-)?(\d+)\.(\d+)\.(\d+)/', $version, $match)) {
        $number = (int) $match[1] * 10000 + (int) $match[2] * 100 + (int) $match[3];
    }
    return array('mariadb' => $mariadb, 'instant' => $mariadb ? $number >= 100302 : $number >= 80012);
}

// The table of a reference: the site's prefix, the namespace of the platform, the name.
function raditi_content_table_name($name) {
    global $wpdb;
    $table = $wpdb->prefix . 'raditi_' . $name;
    return strlen($table) <= 64 && preg_match('/^[A-Za-z0-9_]+$/D', $table) ? $table : null;
}

function raditi_content_column_types() {
    return array('string', 'text', 'long_text', 'integer', 'big_integer', 'unsigned_big_integer', 'boolean', 'decimal', 'date', 'datetime');
}

// A default of a column in its one spelling, as the platform's dictionary takes it (db-objects.ts).
function raditi_content_default_valid($column) {
    if (!isset($column['default'])) { return true; }
    $given = $column['default'];
    if (!is_array($given) || count($given) !== 1) { return false; }
    if (array_key_exists('now', $given)) { return $given['now'] === true && $column['type'] === 'datetime'; }
    if (!array_key_exists('value', $given) || !is_string($given['value'])) { return false; }
    $value = $given['value'];
    switch ($column['type']) {
        case 'text': case 'long_text': return false;
        case 'string':
            return preg_match('/[\p{Cc}\x{2028}\x{2029}\'\\\\]/u', $value) === 0 && mb_strlen($value, 'UTF-8') <= $column['length'];
        case 'boolean': return $value === '0' || $value === '1';
        case 'integer': return preg_match('/^-?(0|[1-9][0-9]{0,9})$/D', $value) === 1 && $value !== '-0' && (float) $value >= -2147483648 && (float) $value <= 2147483647;
        case 'big_integer': return preg_match('/^-?(0|[1-9][0-9]{0,18})$/D', $value) === 1 && $value !== '-0';
        case 'unsigned_big_integer': return preg_match('/^(0|[1-9][0-9]{0,19})$/D', $value) === 1;
        case 'decimal':
            $scale = $column['scale'];
            $pattern = $scale === 0 ? '/^-?(0|[1-9][0-9]*)$/D' : '/^-?(0|[1-9][0-9]*)\.[0-9]{' . $scale . '}$/D';
            $whole = explode('.', ltrim($value, '-'))[0];
            return preg_match($pattern, $value) === 1 && strlen($whole) <= max(1, $column['precision'] - $scale) && preg_match('/^-0(\.0+)?$/D', $value) !== 1;
        case 'date': return preg_match('/^(\d{4})-(\d{2})-(\d{2})$/D', $value, $m) === 1 && checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
        case 'datetime': return preg_match('/^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/D', $value, $m) === 1 && checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
    }
    return false;
}

// A definition of the dictionary in its one key order, or null when it is not one.
function raditi_content_definition($given) {
    if (!is_array($given) || count($given) !== 2 || !isset($given['columns'], $given['indexes'])
        || !is_array($given['columns']) || !is_array($given['indexes'])
        || count($given['columns']) < 1 || count($given['columns']) > 31 || count($given['indexes']) > 8) { return null; }
    $columns = array();
    $types = array();
    foreach ($given['columns'] as $column) {
        if (!is_array($column) || array_diff(array_keys($column), array('name', 'type', 'length', 'precision', 'scale', 'nullable', 'default'))
            || !isset($column['name'], $column['type']) || !is_string($column['name']) || !is_string($column['type'])
            || !preg_match('/^[a-z][a-z0-9_]{0,40}$/D', $column['name']) || $column['name'] === 'id' || isset($types[$column['name']])
            || !in_array($column['type'], raditi_content_column_types(), true)
            || !array_key_exists('nullable', $column) || !is_bool($column['nullable'])) { return null; }
        $string = $column['type'] === 'string';
        $decimal = $column['type'] === 'decimal';
        if ($string !== isset($column['length']) || $decimal !== isset($column['precision']) || $decimal !== isset($column['scale'])
            || ($string && (!is_int($column['length']) || $column['length'] < 1 || $column['length'] > 191))
            || ($decimal && (!is_int($column['precision']) || !is_int($column['scale']) || $column['precision'] < 1 || $column['precision'] > 18
                || $column['scale'] < 0 || $column['scale'] > 6 || $column['scale'] > $column['precision']))
            || !raditi_content_default_valid($column)) { return null; }
        $normal = array('name' => $column['name'], 'type' => $column['type']);
        foreach (array('length', 'precision', 'scale') as $key) { if (isset($column[$key])) { $normal[$key] = $column[$key]; } }
        $normal['nullable'] = $column['nullable'];
        if (isset($column['default'])) { $normal['default'] = $column['default']; }
        $columns[] = $normal;
        $types[$column['name']] = $column['type'];
    }
    $indexes = array();
    $previous = null;
    foreach ($given['indexes'] as $index) {
        if (!is_array($index) || count($index) !== 3 || !isset($index['name'], $index['columns']) || !array_key_exists('unique', $index)
            || !is_string($index['name']) || !preg_match('/^[a-z][a-z0-9_]{0,40}$/D', $index['name']) || $index['name'] === 'primary'
            || ($previous !== null && strcmp($previous, $index['name']) >= 0) || !is_bool($index['unique'])
            || !is_array($index['columns']) || count($index['columns']) < 1 || count($index['columns']) > 4
            || count(array_unique($index['columns'])) !== count($index['columns'])) { return null; }
        foreach ($index['columns'] as $name) {
            if (!is_string($name) || !isset($types[$name]) || in_array($types[$name], array('text', 'long_text'), true)) { return null; }
        }
        $indexes[] = array('name' => $index['name'], 'columns' => array_values($index['columns']), 'unique' => $index['unique']);
        $previous = $index['name'];
    }
    return array('columns' => $columns, 'indexes' => $indexes);
}

// A default as the catalog of the server shows it, in the dictionary's spelling: null — none,
// false — something the dictionary cannot say (an expression).
function raditi_content_catalog_default($raw, $type, $mariadb, $generated) {
    if ($raw === null || ($mariadb && $raw === 'NULL')) { return null; }
    if (preg_match('/^current_timestamp(\(\))?$/iD', $raw)) { return $type === 'datetime' ? array('now' => true) : false; }
    if ($mariadb) {
        if (preg_match("/^'(.*)'\$/sD", $raw, $match)) { $raw = $match[1]; }
        elseif (preg_match('/^-?[0-9]+(\.[0-9]+)?$/D', $raw) !== 1) { return false; }
    } elseif ($generated) { return false; }
    if ($type === 'text' || $type === 'long_text') { return false; }
    return array('value' => (string) $raw);
}

// The definition of a table of the platform as the catalog says it, in the dictionary: the
// implicit `id` first and the primary key on it alone, InnoDB, no foreign key, every column and
// index of a kind the dictionary knows. null — the table is not one the dictionary can say.
function raditi_content_catalog_definition($table, $mariadb) {
    global $wpdb;
    $rows = raditi_content_sql_rows($wpdb->prepare('SELECT COLUMN_NAME AS name, DATA_TYPE AS data, COLUMN_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS length, NUMERIC_PRECISION AS digits, NUMERIC_SCALE AS scale, DATETIME_PRECISION AS fraction, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s ORDER BY ORDINAL_POSITION', $table));
    if (!$rows) { return false === $rows ? false : null; }
    $first = array_shift($rows);
    if ($first['name'] !== 'id' || strtolower($first['data']) !== 'bigint' || stripos($first['type'], 'unsigned') === false
        || $first['nullable'] !== 'NO' || stripos((string) $first['extra'], 'auto_increment') === false || !$rows) { return null; }
    $columns = array();
    $types = array();
    foreach ($rows as $row) {
        $data = strtolower((string) $row['data']);
        $sql = strtolower((string) $row['type']);
        $extra = strtolower(trim((string) $row['extra']));
        $generated = $extra === 'default_generated';
        if (($extra !== '' && !$generated) || strpos($sql, 'zerofill') !== false) { return null; }
        $unsigned = strpos($sql, 'unsigned') !== false;
        $column = array('name' => (string) $row['name']);
        if ($data === 'varchar' && !$unsigned) { $column['type'] = 'string'; $column['length'] = (int) $row['length']; }
        elseif ($data === 'text') { $column['type'] = 'text'; }
        elseif ($data === 'longtext') { $column['type'] = 'long_text'; }
        elseif ($data === 'int' && !$unsigned) { $column['type'] = 'integer'; }
        elseif ($data === 'bigint') { $column['type'] = $unsigned ? 'unsigned_big_integer' : 'big_integer'; }
        elseif ($data === 'tinyint' && $sql === 'tinyint(1)') { $column['type'] = 'boolean'; }
        elseif ($data === 'decimal' && !$unsigned) { $column['type'] = 'decimal'; $column['precision'] = (int) $row['digits']; $column['scale'] = (int) $row['scale']; }
        elseif ($data === 'date') { $column['type'] = 'date'; }
        elseif ($data === 'datetime' && (int) $row['fraction'] === 0) { $column['type'] = 'datetime'; }
        else { return null; }
        $column['nullable'] = $row['nullable'] === 'YES';
        $default = raditi_content_catalog_default($row['dflt'], $column['type'], $mariadb, $generated);
        if ($default === false) { return null; }
        if ($default !== null) { $column['default'] = $default; }
        $columns[] = $column;
        $types[$column['name']] = $column['type'];
    }
    $rows = raditi_content_sql_rows($wpdb->prepare('SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col, SUB_PART AS sub, INDEX_TYPE AS kind FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s ORDER BY INDEX_NAME, SEQ_IN_INDEX', $table));
    $foreign = raditi_content_sql_value($wpdb->prepare('SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND REFERENCED_TABLE_NAME IS NOT NULL', $table));
    if ($rows === false || $foreign === null) { return false; }
    if ((int) $foreign > 0) { return null; }
    $primary = array();
    $indexes = array();
    foreach ($rows as $row) {
        if ($row['sub'] !== null || strtoupper((string) $row['kind']) !== 'BTREE') { return null; }
        if ($row['name'] === 'PRIMARY') { $primary[] = $row['col']; continue; }
        $indexes[$row['name']]['columns'][] = $row['col'];
        $indexes[$row['name']]['unique'] = $row['non_unique'] === '0';
    }
    if ($primary !== array('id')) { return null; }
    ksort($indexes, SORT_STRING);
    $list = array();
    foreach ($indexes as $name => $index) {
        $list[] = array('name' => (string) $name, 'columns' => $index['columns'], 'unique' => $index['unique']);
    }
    return raditi_content_definition(array('columns' => $columns, 'indexes' => $list));
}

function raditi_content_table_hash($ref, $exists, $managed, $definition) {
    $frames = array('table', $ref, $exists ? '1' : '0', $managed ? '1' : '0');
    if ($definition !== null) {
        foreach ($definition['columns'] as $column) {
            $given = isset($column['default']) ? $column['default'] : null;
            array_push($frames, 'c', $column['name'], $column['type'],
                isset($column['length']) ? (string) $column['length'] : '',
                isset($column['precision']) ? (string) $column['precision'] : '',
                isset($column['scale']) ? (string) $column['scale'] : '',
                $column['nullable'] ? '1' : '0',
                $given === null ? '' : (isset($given['now']) ? 'now' : 'v'),
                $given !== null && isset($given['value']) ? (string) $given['value'] : '');
        }
        foreach ($definition['indexes'] as $index) {
            array_push($frames, 'i', $index['name'], $index['unique'] ? '1' : '0', implode(',', $index['columns']));
        }
    }
    return hash('sha256', raditi_content_frames($frames));
}

// A table of the platform as it stands: there or not, made by the platform (its comment) or not,
// and its definition in the dictionary. false — the database did not answer.
function raditi_content_table_state($name) {
    global $wpdb;
    $table = raditi_content_table_name($name);
    $ref = 'table:' . $name;
    if ($table === null) { return false; }
    $info = raditi_content_sql_rows($wpdb->prepare('SELECT ENGINE AS engine, TABLE_COMMENT AS note, TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table));
    if ($info === false) { return false; }
    $exists = count($info) > 0;
    $managed = $exists && $info[0]['note'] === 'raditi-managed' && $info[0]['kind'] === 'BASE TABLE' && strtolower((string) $info[0]['engine']) === 'innodb';
    $definition = null;
    if ($managed) {
        $definition = raditi_content_catalog_definition($table, raditi_content_server()['mariadb']);
        if ($definition === false) { return false; }
    }
    return array('version' => 1, 'objectRef' => $ref, 'exists' => $exists, 'managed' => $managed, 'definition' => $definition,
        'stateHash' => raditi_content_table_hash($ref, $exists, $managed, $definition));
}

function raditi_content_table_read($request) {
    if (!current_user_can('manage_options')) { return raditi_content_rejected('invalid'); }
    $state = raditi_content_table_state((string) $request['name']);
    if ($state === false) { return raditi_content_rejected('unavailable'); }
    return new WP_REST_Response($state, 200);
}

function raditi_content_column_sql($column) {
    global $wpdb;
    $types = array('string' => 'VARCHAR(' . (isset($column['length']) ? (int) $column['length'] : 0) . ')', 'text' => 'TEXT',
        'long_text' => 'LONGTEXT', 'integer' => 'INT', 'big_integer' => 'BIGINT', 'unsigned_big_integer' => 'BIGINT UNSIGNED',
        'boolean' => 'TINYINT(1)', 'date' => 'DATE', 'datetime' => 'DATETIME',
        'decimal' => 'DECIMAL(' . (isset($column['precision']) ? (int) $column['precision'] : 0) . ',' . (isset($column['scale']) ? (int) $column['scale'] : 0) . ')');
    $sql = '`' . $column['name'] . '` ' . $types[$column['type']] . ($column['nullable'] ? ' NULL' : ' NOT NULL');
    if (isset($column['default']['now'])) { $sql .= ' DEFAULT CURRENT_TIMESTAMP'; }
    elseif (isset($column['default']['value'])) { $sql .= ' DEFAULT ' . $wpdb->prepare('%s', $column['default']['value']); }
    return $sql;
}

function raditi_content_index_sql($index) {
    return ($index['unique'] ? 'UNIQUE KEY `' : 'KEY `') . $index['name'] . '` (`' . implode('`, `', $index['columns']) . '`)';
}

// What `longer` adds to `shorter`: the columns after all of `shorter`'s, unchanged and in their
// order, and the indexes beside all of `shorter`'s, unchanged. null — it changes or removes one.
function raditi_content_extends($longer, $shorter) {
    $same = function ($a, $b) { return wp_json_encode($a) === wp_json_encode($b); };
    if (count($longer['columns']) < count($shorter['columns'])) { return null; }
    foreach ($shorter['columns'] as $at => $column) { if (!$same($column, $longer['columns'][$at])) { return null; } }
    $named = array();
    foreach ($longer['indexes'] as $index) { $named[$index['name']] = $index; }
    foreach ($shorter['indexes'] as $index) {
        if (!isset($named[$index['name']]) || !$same($named[$index['name']], $index)) { return null; }
        unset($named[$index['name']]);
    }
    return array('columns' => array_slice($longer['columns'], count($shorter['columns'])), 'indexes' => array_values($named));
}

// The statements that take a table from `before` to `target`, each with the definition it leaves:
// a creation; added columns (INSTANT), then added indexes (INPLACE, no lock) — each new column
// nullable or with a constant default, no new index unique; in a preview alone, taking the table
// or the platform's own additions away again. null — anything else.
function raditi_content_table_steps($table, $before, $target, $preview) {
    global $wpdb;
    if (!$before['exists']) {
        if ($target === null) { return array(); }
        $parts = array('`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT');
        foreach ($target['columns'] as $column) { $parts[] = raditi_content_column_sql($column); }
        $parts[] = 'PRIMARY KEY (`id`)';
        foreach ($target['indexes'] as $index) { $parts[] = raditi_content_index_sql($index); }
        return array(array('sql' => "CREATE TABLE `$table` (" . implode(', ', $parts) . ') ENGINE=InnoDB ' . $wpdb->get_charset_collate() . " COMMENT='raditi-managed'", 'definition' => $target));
    }
    $current = $before['definition'];
    if (!$before['managed'] || $current === null) { return null; }
    if ($target === null) { return $preview ? array(array('sql' => "DROP TABLE `$table`", 'definition' => null)) : null; }
    $grows = raditi_content_extends($target, $current);
    if ($grows !== null) {
        $steps = array();
        if ($grows['columns']) {
            $sql = array();
            foreach ($grows['columns'] as $column) {
                if (isset($column['default']['now']) || (!$column['nullable'] && !isset($column['default']))) { return null; }
                $sql[] = 'ADD COLUMN ' . raditi_content_column_sql($column);
            }
            $steps[] = array('sql' => "ALTER TABLE `$table` " . implode(', ', $sql) . ', ALGORITHM=INSTANT',
                'definition' => array('columns' => $target['columns'], 'indexes' => $current['indexes']));
        }
        if ($grows['indexes']) {
            $sql = array();
            foreach ($grows['indexes'] as $index) {
                if ($index['unique']) { return null; }
                $sql[] = 'ADD ' . raditi_content_index_sql($index);
            }
            $steps[] = array('sql' => "ALTER TABLE `$table` " . implode(', ', $sql) . ', ALGORITHM=INPLACE, LOCK=NONE', 'definition' => $target);
        }
        return $steps;
    }
    $shrinks = raditi_content_extends($current, $target);
    if ($shrinks === null || !$preview) { return null; }
    $drops = array();
    foreach ($shrinks['indexes'] as $index) { $drops[] = 'DROP INDEX `' . $index['name'] . '`'; }
    foreach ($shrinks['columns'] as $column) { $drops[] = 'DROP COLUMN `' . $column['name'] . '`'; }
    return array(array('sql' => "ALTER TABLE `$table` " . implode(', ', $drops), 'definition' => $target));
}

// A table of the platform. The fence is checked and moved in a transaction of its own, then the
// statements run — the server commits each by itself, and none waits more than 5 seconds for the
// lock of a table, so the site is never queued behind it. A repeat finds the table where a step
// left it and goes on from there; what a table holds is the outcome, its receipt only says so.
function raditi_content_table_write($request) {
    global $wpdb;
    $name = (string) $request['name'];
    if (!current_user_can('manage_options')) { return raditi_content_rejected('invalid'); }
    $input = raditi_content_db_input($request, array('before', 'definition'));
    $table = raditi_content_table_name($name);
    if (!$input || $table === null || $input['objectRef'] !== 'table:' . $name) { return raditi_content_rejected('invalid'); }
    $given = $input['before'];
    $target = $input['definition'] === null ? null : raditi_content_definition($input['definition']);
    if (!is_array($given) || count($given) !== 3 || !isset($given['exists'], $given['managed']) || !is_bool($given['exists'])
        || !is_bool($given['managed']) || !array_key_exists('definition', $given)
        || ($input['definition'] !== null && $target === null)) { return raditi_content_rejected('invalid'); }
    $before = array('exists' => $given['exists'], 'managed' => $given['managed'],
        'definition' => $given['definition'] === null ? null : raditi_content_definition($given['definition']));
    if (($given['definition'] !== null && $before['definition'] === null)
        || !hash_equals(raditi_content_table_hash($input['objectRef'], $before['exists'], $before['managed'], $before['definition']), $input['expectedStateHash'])) {
        return raditi_content_rejected('invalid');
    }
    $server = raditi_content_server();
    if (!$server['instant']) { return raditi_content_rejected('invalid', 'unsupported'); }
    $steps = raditi_content_table_steps($table, $before, $target, defined('RADITI_PREVIEW_ORIGIN'));
    if ($steps === null) { return raditi_content_rejected('invalid', 'unsupported'); }
    $target_hash = raditi_content_table_hash($input['objectRef'], $target !== null, $target !== null, $target);
    if (!raditi_content_innodb(array($wpdb->options))) { return raditi_content_rejected('unavailable'); }
    $digest = raditi_content_db_digest($input);
    $hashes = array($input['expectedStateHash']);
    foreach ($steps as $step) {
        $hashes[] = raditi_content_table_hash($input['objectRef'], $step['definition'] !== null, $step['definition'] !== null, $step['definition']);
    }
    $committed = false;
    try {
        $begun = raditi_content_db_begin($input, $digest);
        if ($begun !== null) { return $begun; }
        $current = raditi_content_table_state($name);
        if ($current === false) { return raditi_content_rejected('unavailable'); }
        $from = array_search($current['stateHash'], $hashes, true);
        if ($from === false) { return raditi_content_rejected('conflict'); }
        if (raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s", (string) $input['epoch'], 'raditi_content_epoch')) === false) {
            return raditi_content_rejected('unavailable');
        }
        if (raditi_content_sql('COMMIT') === false) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503); }
        $committed = true;
    } finally {
        if (!$committed) { raditi_content_sql('ROLLBACK'); }
    }
    raditi_content_sql('SET SESSION lock_wait_timeout = 5');
    raditi_content_sql('SET SESSION innodb_lock_wait_timeout = 5');
    foreach (array_slice($steps, $from) as $step) {
        if (raditi_content_sql($step['sql']) === false) {
            $code = mysqli_errno($wpdb->dbh);
            $now = raditi_content_table_state($name);
            // Unchanged by this request: a refusal. Changed part of the way: the caller does not know.
            if ($now === false || $now['stateHash'] !== $hashes[$from]) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503); }
            return in_array($code, array(1845, 1846), true) ? raditi_content_rejected('invalid', 'unsupported') : raditi_content_rejected('unavailable');
        }
        $from++;
    }
    $after = raditi_content_table_state($name);
    if ($after === false || $after['stateHash'] !== $target_hash) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503); }
    $proof = raditi_content_db_proof($input, $target_hash);
    if (raditi_content_sql($wpdb->prepare("INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')", 'raditi_content_call_' . $input['callId'],
        wp_json_encode(array('digest' => $digest, 'proof' => $proof, 'deadlineAt' => $input['deadlineAt'])))) === false) {
        return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503);
    }
    return new WP_REST_Response($proof, 200);
}

// Moves the fence to an epoch when it is lower, writing nothing else (docs/plan/53, «Операции БД
// и миграции»): after it no write of an earlier epoch can still commit, whatever its time left.
function raditi_content_fence($request) {
    global $wpdb;
    $input = $request->get_json_params();
    if (!is_array($input) || count($input) !== 2 || !isset($input['siteId'], $input['epoch'])
        || $input['siteId'] !== get_option('raditi_content_site_id', '') || !is_int($input['epoch'])
        || $input['epoch'] < 1 || $input['epoch'] > 2147483647 || !current_user_can('manage_options')) {
        return raditi_content_rejected('invalid');
    }
    if (!raditi_content_innodb(array($wpdb->options))) { return raditi_content_rejected('unavailable'); }
    if (raditi_content_sql('START TRANSACTION') === false) { return raditi_content_rejected('unavailable'); }
    $committed = false;
    try {
        if (raditi_content_sql($wpdb->prepare("INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '0', 'no')", 'raditi_content_epoch')) === false) {
            return raditi_content_rejected('unavailable');
        }
        $epoch = raditi_content_sql_value($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", 'raditi_content_epoch'));
        if ($epoch === null) { return raditi_content_rejected('unavailable'); }
        if ((int) $epoch < $input['epoch'] && raditi_content_sql($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s",
            (string) $input['epoch'], 'raditi_content_epoch')) === false) {
            return raditi_content_rejected('unavailable');
        }
        if (raditi_content_sql('COMMIT') === false) { return new WP_REST_Response(array('version' => 1, 'kind' => 'unknown'), 503); }
        $committed = true;
        return new WP_REST_Response(array('version' => 1, 'kind' => 'fenced', 'epoch' => max((int) $epoch, $input['epoch'])), 200);
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
    register_rest_route('raditi/v1', '/runtime', array(
        'methods' => 'GET', 'callback' => 'raditi_content_runtime', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/code-cache', array(
        array('methods' => 'GET', 'callback' => 'raditi_content_code_cache', 'permission_callback' => 'raditi_content_permission'),
        array('methods' => 'POST', 'callback' => 'raditi_content_code_cache_refresh', 'permission_callback' => 'raditi_content_permission'),
    ));
    register_rest_route('raditi/v1', '/capabilities', array(
        'methods' => 'GET', 'callback' => 'raditi_content_capabilities', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/fence', array(
        'methods' => 'POST', 'callback' => 'raditi_content_fence', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/records/(?P<type>post|page)', array(
        'methods' => 'POST', 'callback' => 'raditi_content_record_create', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/records/(?P<type>post|page)/(?P<id>[1-9][0-9]{0,9})', array(
        'methods' => 'GET', 'callback' => 'raditi_content_record_read', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/records/(?P<type>post|page)/(?P<id>[1-9][0-9]{0,9})/trash', array(
        'methods' => 'POST', 'callback' => 'raditi_content_record_trash', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/records/(?P<type>post|page)/(?P<id>[1-9][0-9]{0,9})/untrash', array(
        'methods' => 'POST', 'callback' => 'raditi_content_record_untrash', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/records/(?P<type>post|page)/(?P<id>[1-9][0-9]{0,9})/dependents', array(
        'methods' => 'GET', 'callback' => 'raditi_content_record_dependents', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/slugs/(?P<type>post|page)/(?P<slug>[a-z0-9-]{1,200})', array(
        'methods' => 'GET', 'callback' => 'raditi_content_slug', 'permission_callback' => 'raditi_content_permission',
    ));
    register_rest_route('raditi/v1', '/settings/(?P<option>[a-z][a-z0-9_]{0,63})', array(
        array('methods' => 'GET', 'callback' => 'raditi_content_setting_read', 'permission_callback' => 'raditi_content_permission'),
        array('methods' => 'POST', 'callback' => 'raditi_content_setting_write', 'permission_callback' => 'raditi_content_permission'),
    ));
    register_rest_route('raditi/v1', '/tables/(?P<name>[a-z][a-z0-9_]{0,29})', array(
        array('methods' => 'GET', 'callback' => 'raditi_content_table_read', 'permission_callback' => 'raditi_content_permission'),
        array('methods' => 'POST', 'callback' => 'raditi_content_table_write', 'permission_callback' => 'raditi_content_permission'),
    ));
});
