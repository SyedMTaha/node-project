const { spawn } = require('child_process');

const list = [
  ['microservices/cache-service.js', 4001],
  ['microservices/upload-service.js', 4002],
  ['microservices/upload-service.js', 4003],
];

const children = list.map(([file, port]) =>
  spawn('node', [file], { env: { ...process.env, PORT: port }, stdio: 'inherit' }));

process.on('SIGINT', () => { children.forEach((c) => c.kill()); process.exit(); });