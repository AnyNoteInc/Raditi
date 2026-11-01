<?php
// The fragment of modx.md §6.5, as written there, in a file a preview runs by CLI.
define('MODX_API_MODE', true);

require '/var/www/html/index.php';
$modx->initialize('mgr');
$userClass = MODX\Revolution\modUser::class; $profileClass = MODX\Revolution\modUserProfile::class;
$password = '<hidden>';
$user = $modx->newObject($userClass, ['username' => 'raditi-platform', 'active' => 1]);
$user->set('password', $password);
$user->setSudo(true);
$profile = $modx->newObject($profileClass);
$profile->fromArray(['email' => 'platform@preview.invalid', 'fullname' => 'Радити']);
$user->addOne($profile);
$saved = $user->save();
$joined = $user->joinGroup('Administrator', 2);
var_dump($saved, $joined, $user->get('id'), $user->get('sudo'), $user->get('primary_group'));
