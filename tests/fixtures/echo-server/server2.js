const http = require('http');
http.createServer((req, res) => { res.end('pong'); }).listen(18898, () => console.log('echo-server-2 on 18898'));
