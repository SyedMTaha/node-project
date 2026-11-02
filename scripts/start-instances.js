//start multiple instances at once for load testing

const { spawn } = require('child_process');

const args = process.argv.slice(2).join(',');
const ports = (args || '3001,3002,3003').split(',').map((p) => p.trim()).filter(Boolean);

const children = ports.map((port) => {
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: port, INSTANCE_ID: `instance-${port}` },
    stdio: 'inherit',
  });
  child.on('exit', (code) => console.log(`instance-${port} exited with code ${code}`));
  return child;
});

process.on('SIGINT', () => {
  children.forEach((c) => c.kill());
  process.exit();
});