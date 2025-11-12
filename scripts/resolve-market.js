const { ethers } = require('hardhat');

function normalizeAddress(addr) {
  if (typeof addr !== 'string') return '';
  const trimmed = addr.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed : '';
}

function mapOutcomeCode(resultRaw) {
  const key = (resultRaw || '').toString().trim().toLowerCase();
  const lookup = {
    yes: 1,
    no: 2,
  };
  return lookup[key];
}

function outcomeName(code) {
  const names = { 1: 'yes', 2: 'no', 3: 'invalid' };
  return names[code] || 'unknown';
}

async function main() {
  const marketAddress = normalizeAddress(process.env.MARKET_ADDRESS);
  if (!marketAddress) {
    throw new Error('MARKET_ADDRESS env var is required (0x...)');
  }
  const resultRaw = process.env.RESOLVE_RESULT || '';
  const outcome = mapOutcomeCode(resultRaw);
  if (!outcome) {
    throw new Error('RESOLVE_RESULT env var must be either "yes" or "no"');
  }

  const [signer] = await ethers.getSigners();
  const resolver = await signer.getAddress();
  const market = await ethers.getContractAt('PredictionMarketNative', marketAddress);

  const currentOutcome = Number(await market.finalOutcome());
  if (currentOutcome !== 0) {
    console.log(
      JSON.stringify({
        success: true,
        skipped: 'already_resolved',
        currentOutcome,
        currentOutcomeName: outcomeName(currentOutcome),
        marketAddress,
      })
    );
    return;
  }

  const forceFlagRaw = process.env.RESOLVE_FORCE || '';
  const forceFlag = typeof forceFlagRaw === 'string'
    ? ['1', 'true', 'yes', 'force'].includes(forceFlagRaw.toLowerCase())
    : false;

  let tx;
  let forced = false;
  if (forceFlag) {
    try {
      tx = await market.forceResolve(outcome);
      forced = true;
    } catch (err) {
      const errMsg = err?.error?.message || err?.message || '';
      if (/selector was not recognized|function does not exist|function selector was not recognized/i.test(errMsg)) {
        throw Object.assign(new Error('forceResolve not supported by market'), { code: 'UNSUPPORTED_FORCE', cause: err });
      }
      throw err;
    }
  }

  if (!tx) {
    tx = await market.resolve(outcome);
  }

  const receipt = await tx.wait();

  console.log(
    JSON.stringify({
      success: true,
      marketAddress,
      resolver,
      outcome,
      outcomeName: outcomeName(outcome),
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber ?? null,
      forced,
    })
  );
}

main().catch((err) => {
  const message = err?.error?.message || err?.message || String(err);
  const detail = err?.data?.message || err?.error?.data?.message;
  const payload = {
    success: false,
    error: message,
  };
  if (err?.code) payload.code = err.code;
  if (err?.code === 'UNSUPPORTED_FORCE') {
    payload.detail = 'forceResolve_not_available_on_contract';
  } else if (detail) {
    payload.detail = detail;
  }
  if (err?.reason) payload.reason = err.reason;
  console.error(JSON.stringify(payload));
  process.exit(1);
});
