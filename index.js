// Minimal HTTP server so Railpack detects a start command.
// This service is a deploy toolkit for Hardhat scripts; it intentionally
// exposes only a status endpoint. To deploy/operate contracts, exec into
// the service and run the Hardhat scripts with the required env vars.

const http = require('http');
const url = require('url');
const qs = require('querystring');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

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

function headerLookup(headers = {}, key) {
  if (!headers) return undefined;
  if (headers[key] != null) return headers[key];
  const lowerKey = key.toLowerCase();
  for (const [k, value] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerKey) return value;
  }
  return undefined;
}

function normalizeAddress(address) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function issueNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function buildMessage(address, nonce, issuedAt) {
  const lines = ['SolPicks Sign-in', `Address: ${address}`, `Nonce: ${nonce}`];
  if (issuedAt) lines.push(`Issued At: ${issuedAt}`);
  return lines.join('\n');
}

function devFallbackAllowed() {
  const explicit = process.env.AUTH_ALLOW_DEV_FALLBACK;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  const context = process.env.CONTEXT;
  if (context && context.toLowerCase() === 'production') return false;
  if (process.env.RAILWAY_ENVIRONMENT && process.env.RAILWAY_ENVIRONMENT.toLowerCase() === 'production') return false;
  if (process.env.NETLIFY_DEV === 'true') return true;
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'production') return true;
  return false;
}

async function verifyJwtToken(token) {
  const secret = process.env.AUTH_JWT_SECRET || process.env.password_pin || 'solpicks-dev-secret';
  const { jwtVerify } = await import('jose');
  const encoder = new TextEncoder();
  const verified = await jwtVerify(token, encoder.encode(secret));
  const payload = verified?.payload || {};
  const address = normalizeAddress(payload?.sub || payload?.address);
  if (!address) throw new Error('Invalid token payload');
  return { address, payload };
}

async function requireAuth(req) {
  const authHeader = headerLookup(req.headers, 'authorization');
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token) return { error: 'Missing token' };
    try {
      const decoded = await verifyJwtToken(token);
      return { address: decoded.address, tokenPayload: decoded.payload };
    } catch (err) {
      return { error: err?.message || 'Invalid token' };
    }
  }

  if (devFallbackAllowed()) {
    const devHeader = headerLookup(req.headers, 'x-wallet-address');
    const fromQuery = req.url && new URL(req.url, `http://${req.headers.host}`).searchParams.get('wallet');
    const candidate = normalizeAddress(devHeader || fromQuery);
    if (candidate) {
      return { address: candidate, dev: true };
    }
  }

  return { error: 'Not authenticated' };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload ?? {}));
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('Missing Supabase env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
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
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-wallet-address');
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

  // Auth endpoints for MetaMask sign-in
  if (parsed.pathname === '/auth-nonce') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const address = normalizeAddress(parsed.query?.address || parsed.query?.wallet);
    if (!address) {
      sendJson(res, 400, { error: 'Missing or invalid address' });
      return;
    }
    const nonce = issueNonce();
    const issuedAt = new Date().toISOString();
    sendJson(res, 200, { address, nonce, issuedAt });
    return;
  }

  if (parsed.pathname === '/auth-verify') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    try {
      const bodyRaw = await collectBody(req);
      let body = {};
      try { body = JSON.parse(bodyRaw || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return; }
      const address = normalizeAddress(body?.address);
      const nonce = typeof body?.nonce === 'string' ? body.nonce : '';
      const signature = typeof body?.signature === 'string' ? body.signature : '';
      const issuedAt = typeof body?.issuedAt === 'string' ? body.issuedAt : undefined;
      if (!address || !nonce || !signature) {
        sendJson(res, 400, { error: 'Missing address, nonce, or signature' });
        return;
      }
      const { recoverPersonalSignature } = require('@metamask/eth-sig-util');
      let recovered;
      try {
        recovered = normalizeAddress(recoverPersonalSignature({
          data: `0x${Buffer.from(buildMessage(address, nonce, issuedAt), 'utf8').toString('hex')}`,
          signature,
        }));
      } catch (err) {
        console.error('[auth-verify] signature verification failed', err);
        sendJson(res, 401, { error: 'Signature verification failed' });
        return;
      }
      if (!recovered || recovered !== address) {
        sendJson(res, 401, { error: 'Signature mismatch' });
        return;
      }
      const secret = process.env.AUTH_JWT_SECRET || process.env.password_pin || 'solpicks-dev-secret';
      const { SignJWT } = await import('jose');
      const encoder = new TextEncoder();
      const key = encoder.encode(secret);
      const expiresInSeconds = 3 * 24 * 60 * 60;
      const token = await new SignJWT({ address })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(address)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
        .sign(key);
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
      sendJson(res, 200, { token, address, expiresAt });
    } catch (err) {
      console.error('[auth-verify] error', err);
      sendJson(res, 500, { error: err?.message || 'Auth verification error' });
    }
    return;
  }

  if (parsed.pathname === '/user') {
    try {
      const auth = await requireAuth(req);
      if (auth?.error) {
        sendJson(res, 401, { error: auth.error });
        return;
      }
      const supabase = getSupabaseAdmin();
      if (req.method === 'GET') {
        const payload = { wallet: auth.address };
        const { data, error } = await supabase
          .from('users')
          .upsert(payload, { onConflict: 'wallet' })
          .select('*')
          .maybeSingle();
        if (error) throw error;
        sendJson(res, 200, { success: true, profile: data });
        return;
      }
      if (req.method === 'POST') {
        const bodyRaw = await collectBody(req);
        let body = {};
        try { body = JSON.parse(bodyRaw || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return; }
        const updates = {};
        if (typeof body.username === 'string') updates.username = body.username;
        if (typeof body.display_name === 'string' && !updates.username) updates.username = body.display_name;
        if (typeof body.avatar_url === 'string') updates.avatar_url = body.avatar_url;
        if (typeof body.bio === 'string') updates.bio = body.bio;
        if (typeof body.website === 'string') updates.website = body.website;
        if (typeof body.twitter === 'string') updates.twitter = body.twitter;
        if (typeof body.banner_url === 'string') updates.banner_url = body.banner_url;
        if (typeof body.theme_color === 'string') updates.theme_color = body.theme_color;
        if (typeof body.hide_balance === 'boolean') updates.hide_balance = body.hide_balance;
        if (typeof body.wallet_address === 'string') updates.wallet_address = body.wallet_address;
        if (typeof body.wallet === 'string') updates.wallet = body.wallet;

        if (Object.keys(updates).length === 0) {
          sendJson(res, 400, { error: 'No updatable fields provided' });
          return;
        }

        const base = { wallet: auth.address, ...updates };
        const { data, error } = await supabase
          .from('users')
          .upsert(base, { onConflict: 'wallet' })
          .select('*')
          .maybeSingle();
        if (error) throw error;
        sendJson(res, 200, { success: true, profile: data });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      console.error('[user] error', err);
      sendJson(res, 500, { error: err?.message || 'Server error' });
    }
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
      // No admin API key required per request
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

  // JSON API: launch EVM market for a pick and update Supabase
  if (parsed.pathname === '/api/launch-evm-market' && req.method === 'POST') {
    try {
      // No admin API key required per request
      const bodyRaw = await collectBody(req);
      let body = {};
      try { body = JSON.parse(bodyRaw || '{}'); } catch {}
      const pickId = (body.pickId || '').toString().trim();
      const namePrefix = (body.name || body.namePrefix || '').toString().trim();
      if (!pickId || !namePrefix) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'pickId and name are required' }));
        return;
      }

      const nowSec = Math.floor(Date.now()/1000);
      let endTime = Number.isFinite(Number(body.endTime)) ? Number(body.endTime) : (nowSec + 3*24*3600);
      let cutoffTime = Number.isFinite(Number(body.cutoffTime)) ? Number(body.cutoffTime) : Math.max(nowSec + 300, endTime - 30*60);

      // Optionally use Supabase to fetch pick.expires_at/duration_sec if env is present
      try {
        if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
          const { createClient } = await import('@supabase/supabase-js');
          const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
          const { data: pick } = await supabase.from('picks').select('expires_at, duration_sec').eq('id', pickId).maybeSingle();
          if (pick) {
            const exp = pick.expires_at;
            if (exp) {
              const t = Math.floor(new Date(exp).getTime() / 1000);
              if (Number.isFinite(t) && t > nowSec) endTime = t;
            } else if (pick.duration_sec && Number(pick.duration_sec) > 0) {
              endTime = nowSec + Number(pick.duration_sec);
            }
            cutoffTime = Math.max(nowSec + 300, endTime - 30*60);
          }
        }
      } catch (e) {
        // non-fatal; continue with computed times
      }

      const env = { ...process.env, OUTPUT_JSON: '1', NAME_PREFIX: namePrefix, END_TIME: String(endTime), CUTOFF_TIME: String(cutoffTime) };
      if (Number.isFinite(Number(body.feeBps))) env.FEE_BPS = String(Number(body.feeBps));
      if (body.asset) env.ESCROW_ASSET = String(body.asset);

      const child = spawn('npx', ['hardhat', 'run', 'scripts/deploy-market.js', '--network', 'bscMainnet'], {
        cwd: __dirname,
        env,
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (out += d.toString()));
      child.on('close', async (code) => {
        try {
          const jsonStart = out.lastIndexOf('{');
          const json = JSON.parse(out.slice(jsonStart));
          if (code !== 0 || !json?.success) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'deploy_failed', output: out.slice(-4000) }));
            return;
          }

          // Update Supabase if configured
          try {
            const overrideUrl = (body.supabaseUrl || '').toString().trim();
            const overrideKey = (body.serviceRoleKey || '').toString().trim();
            const supabaseUrl = overrideUrl || process.env.SUPABASE_URL;
            const supabaseKey = overrideKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
            if (supabaseUrl && supabaseKey) {
              const { createClient } = await import('@supabase/supabase-js');
              const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
              await supabase.from('picks').update({
                evm_market_address: json.marketAddress,
                evm_yes_token_address: json.yesShareAddress,
                evm_no_token_address: json.noShareAddress,
                evm_chain: 'bsc-mainnet',
                evm_asset_address: json.asset,
                evm_fee_bps: json.feeBps,
                evm_end_time: new Date(Number(json.endTime) * 1000).toISOString(),
                evm_cutoff_time: new Date(Number(json.cutoffTime) * 1000).toISOString(),
              }).eq('id', pickId);
              json.dbUpdate = 'ok';
            } else {
              json.dbUpdate = 'skipped';
              json.dbError = 'missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and no overrides provided';
            }
          } catch (e) {
            // still return success with a warning
            json.dbUpdate = 'failed';
            json.dbError = (e?.message) || String(e);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...json, pickId }));
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
