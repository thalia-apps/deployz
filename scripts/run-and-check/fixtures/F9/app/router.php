<?php
if ($_SERVER['REQUEST_URI'] === '/status/live') {
    echo 'ok';
} else {
    http_response_code(404);
}
