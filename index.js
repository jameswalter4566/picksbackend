// Minimal HTTP server so Railpack detects a start command.
// This service is a deploy toolkit for Hardhat scripts; it intentionally
// exposes only a status endpoint. To deploy/operate contracts, exec into
// the service and run the Hardhat scripts with the required env vars.

const http = require('http');

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify(
      {
        name: 'picksbackend-evm',
        status: 'ready',
        message:
          'Exec into this service to run Hardhat scripts: npx hardhat run scripts/deploy-market.js --network bscMainnet',
        time: new Date().toISOString(),
      },
      null,
      2
    )
  );
});

server.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`picksbackend-evm status server listening on :${port}`);
});

