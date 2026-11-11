const http = require('http');
http.createServer((req, res) => { res.end('pong'); }).listen(18899, () => console.log('echo-server on 18899'));
