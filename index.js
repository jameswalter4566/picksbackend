// Minimal HTTP server so Railpack detects a start command.
// This service is a deploy toolkit for Hardhat scripts; it intentionally
// exposes only a status endpoint. To deploy/operate contracts, exec into
// the service and run the Hardhat scripts with the required env vars.

const http = require('http');
const url = require('url');
const qs = require('querystring');
const { spawn } = require('child_process');
const crypto = require('crypto');

const port = process.env.PORT || 3000;

function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  const out = {};
  header.split(';').forEach((p) => {
    const idx = p.indexOf('=');
    if (idx > -1) out[p.slice(0, idx).trim()] = decodeURIComponent(p.slice(idx + 1).trim());
  });
  return out;
}

function sessionToken() {
  const pin = process.env.password_pin || '';
  return crypto.createHash('sha256').update(`${pin}|v1`).digest('hex');
}

function isAuthed(req) {
  const c = parseCookies(req);
  return c.admin_session && process.env.password_pin && c.admin_session === sessionToken();
}

function html(head, body) {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${head}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;margin:2rem;}
  .card{max-width:820px;margin:auto;border:1px solid #ddd;border-radius:10px;padding:20px;box-shadow:0 2px 10px #0001}
  h1{margin-top:0} code{background:#f6f8fa;padding:2px 4px;border-radius:4px}
  table{border-collapse:collapse;width:100%;margin:1rem 0} td,th{border:1px solid #eee;padding:8px;text-align:left}
  .btn{display:inline-block;padding:10px 14px;background:#0d6efd;color:#fff;border-radius:6px;text-decoration:none;border:0;cursor:pointer}
  .btn:disabled{opacity:.6;cursor:not-allowed}
  .row{display:flex;gap:12px;flex-wrap:wrap}
  pre{background:#0a0a0a;color:#eaeaea;padding:12px;border-radius:8px;overflow:auto}
  .danger{color:#b00020}
  </style></head><body><div class="card">${body}</div></body></html>`;
}

function mask(addr) {
  if (!addr) return '—';
  const s = String(addr);
  return s.length <= 10 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

async function collectBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  // Simple permissive CORS to allow SPA admin page cross-origin with cookies
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/health' || parsed.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Admin login page
  if (parsed.pathname === '/mein/arbeit') {
    if (!process.env.password_pin) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(
        html(
          'Admin - Missing password',
          `<h1>Admin</h1><p class="danger">Missing Railway secret <code>password_pin</code>. Set it and redeploy.</p>`
        )
      );
      return;
    }

    if (!isAuthed(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        html(
          'Admin Login',
          `<h1>Admin Login</h1>
           <form method="post" action="/mein/arbeit/login">
             <label>Password PIN<br/><input name="pin" type="password" autocomplete="off" autofocus required/></label>
             <div style="margin-top:12px"><button class="btn" type="submit">Sign in</button></div>
           </form>`
        )
      );
      return;
    }

    // Show admin dashboard
    const rpc = process.env.ANKR_API_KEY ? 'ANKR_API_KEY' : (process.env.BSC_MAINNET_RPC ? 'BSC_MAINNET_RPC' : '—');
    const DEFAULT_ASSET = '0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const effectiveAsset = process.env.ESCROW_ASSET || `${DEFAULT_ASSET} (default WBNB)`;
    const details = [
      ['RPC source', rpc],
      ['DEPLOYER_PK present', process.env.DEPLOYER_PK ? 'yes' : 'no'],
      ['RESOLVER (effective)', process.env.RESOLVER ? mask(process.env.RESOLVER) : 'defaults to deployer'],
      ['FEE_RECIPIENT (effective)', process.env.FEE_RECIPIENT ? mask(process.env.FEE_RECIPIENT) : 'defaults to deployer'],
      ['ESCROW_ASSET (effective)', mask(effectiveAsset)],
      ['FEE_BPS', String(process.env.FEE_BPS || 300)],
      ['FACTORY_ADDR', mask(process.env.FACTORY_ADDR)],
      ['Time', new Date().toISOString()],
    ];

    const rows = details
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`) 
      .join('');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      html(
        'Admin',
        `<div class="row" style="justify-content:space-between;align-items:center">
           <h1 style="margin:0">Backend Admin</h1>
           <div><a class="btn" href="/mein/arbeit/logout">Logout</a></div>
         </div>
         <p>This page can launch a test market (vault) on BSC mainnet using your configured secrets. Review details then click Launch Program.</p>
         <table>${rows}</table>
         <form method="post" action="/mein/arbeit/launch">
           <button class="btn" type="submit">Launch Program (Deploy Test Market)</button>
         </form>`
      )
    );
    return;
  }

  if (parsed.pathname === '/mein/arbeit/login' && req.method === 'POST') {
    const body = await collectBody(req);
    const data = qs.parse(body);
    const ok = data.pin && process.env.password_pin && String(data.pin) === String(process.env.password_pin);
    if (ok) {
      const token = sessionToken();
      res.writeHead(303, {
        'Set-Cookie': `admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${7 * 24 * 3600}`,
        Location: '/mein/arbeit',
      });
      res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end(html('Unauthorized', `<h1>Unauthorized</h1><p class="danger">Invalid PIN</p><p><a class="btn" href="/mein/arbeit">Try again</a></p>`));
    }
    return;
  }

  if (parsed.pathname === '/mein/arbeit/logout') {
    res.writeHead(303, {
      'Set-Cookie': 'admin_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0',
      Location: '/mein/arbeit',
    });
    res.end();
    return;
  }

  if (parsed.pathname === '/mein/arbeit/launch' && req.method === 'POST') {
    if (!isAuthed(req)) {
      res.writeHead(303, { Location: '/mein/arbeit' });
      res.end();
      return;
    }
    // Validate required env
    const missing = [];
    if (!(process.env.ANKR_API_KEY || process.env.BSC_MAINNET_RPC)) missing.push('ANKR_API_KEY');
    if (!process.env.DEPLOYER_PK) missing.push('DEPLOYER_PK');
    if (missing.length) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(
        html(
          'Missing configuration',
          `<h1>Missing configuration</h1><p class="danger">Set the following secrets: ${missing.join(', ')}</p><p><a class="btn" href="/mein/arbeit">Back</a></p>`
        )
      );
      return;
    }

    // Run the Hardhat deploy script and capture output
    const child = spawn('npx', ['hardhat', 'run', 'scripts/deploy-market.js', '--network', 'bscMainnet'], {
      cwd: __dirname,
      env: process.env,
    });

    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));

    child.on('close', (code) => {
      const ok = code === 0;
      const title = ok ? 'Launch Complete' : 'Launch Failed';
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'text/html' });
      res.end(
        html(
          title,
          `<h1>${title}</h1>
           <p>Status: ${ok ? 'Success' : '<span class="danger">Error</span>'}</p>
           <h3>Logs</h3>
           <pre>${out.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))}</pre>
           <p><a class="btn" href="/mein/arbeit">Back to Admin</a></p>`
        )
      );
    });
    return;
  }

  // JSON API: deploy a market (admin API key required)
  if (parsed.pathname === '/api/deploy-market' && req.method === 'POST') {
    try {
      const apiKey = req.headers['x-api-key'] || req.headers['x-admin-key'];
      if (!process.env.admin_api_key || apiKey !== process.env.admin_api_key) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const bodyRaw = await collectBody(req);
      let body = {};
      try { body = JSON.parse(bodyRaw || '{}'); } catch {}
      const namePrefix = (body.namePrefix || 'Example Pick').toString();
      const feeBps = body.feeBps && Number.isFinite(Number(body.feeBps)) ? String(Number(body.feeBps)) : undefined;
      const asset = body.asset ? String(body.asset) : undefined;
      // endTime/cutoffTime are seconds
      const endTime = body.endTime && Number.isFinite(Number(body.endTime)) ? String(Number(body.endTime)) : undefined;
      const cutoffTime = body.cutoffTime && Number.isFinite(Number(body.cutoffTime)) ? String(Number(body.cutoffTime)) : undefined;

      const env = { ...process.env, OUTPUT_JSON: '1', NAME_PREFIX: namePrefix };
      if (feeBps) env.FEE_BPS = feeBps;
      if (asset) env.ESCROW_ASSET = asset;
      if (endTime) env.END_TIME = endTime;
      if (cutoffTime) env.CUTOFF_TIME = cutoffTime;

      const child = spawn('npx', ['hardhat', 'run', 'scripts/deploy-market.js', '--network', 'bscMainnet'], {
        cwd: __dirname,
        env,
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (out += d.toString()));
      child.on('close', (code) => {
        try {
          const jsonStart = out.lastIndexOf('{');
          const json = JSON.parse(out.slice(jsonStart));
          res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'parse_error', code, output: out.slice(-4000) }));
        }
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e?.message || String(e) }));
    }
    return;
  }

  // Default JSON status
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
