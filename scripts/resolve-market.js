const { ethers } = require('hardhat');

function normalizeAddress(addr) {
  if (typeof addr !== 'string') return '';
  const trimmed = addr.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed : '';
}

function mapOutcomeCode(resultRaw) {
  const key = (resultRaw || '').toString().trim().toLowerCase();
  const lookup = {
    less: 1,
    under: 1,
    yes: 1,
    more: 2,
    over: 2,
    no: 2,
    void: 3,
    invalid: 3,
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
    throw new Error('RESOLVE_RESULT env var must be one of: less, more, void, yes, no, invalid, under, over');
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

  const tx = await market.resolve(outcome);
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
  if (detail) payload.detail = detail;
  if (err?.code) payload.code = err.code;
  if (err?.reason) payload.reason = err.reason;
  console.error(JSON.stringify(payload));
  process.exit(1);
});
