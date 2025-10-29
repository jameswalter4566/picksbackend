const { ethers } = require('hardhat');

function normalizeAddress(addr) {
  if (typeof addr !== 'string') return '';
  const trimmed = addr.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : '';
}

function parseClaimEvent(receipt, iface) {
  if (!receipt?.logs || !iface) return null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'Claimed') {
        return {
          user: normalizeAddress(parsed.args?.user),
          burnedShares: parsed.args?.burnedShares,
          paidOut: parsed.args?.paidOut,
        };
      }
    } catch (_) {
      // ignore non-matching logs
    }
  }
  return null;
}

async function main() {
  const marketAddress = normalizeAddress(process.env.MARKET_ADDRESS);
  if (!marketAddress) {
    throw new Error('MARKET_ADDRESS env var is required (0x...)');
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error('No signer available');
  }
  const signerAddress = normalizeAddress(await signer.getAddress());

  const claimWallet = normalizeAddress(process.env.CLAIM_WALLET) || signerAddress;
  if (!claimWallet) {
    throw new Error('CLAIM_WALLET env var required for relayed claims');
  }

  const market = await ethers.getContractAt('PredictionMarketNative', marketAddress, signer);

  const outcome = Number(await market.finalOutcome());
  if (outcome === 0) {
    throw new Error('market not resolved');
  }

  let usedClaimFor = false;
  let tx;

  if (claimWallet !== signerAddress) {
    try {
      tx = await market.claimFor(claimWallet);
      usedClaimFor = true;
    } catch (err) {
      const errMsg = err?.error?.message || err?.message || '';
      if (/selector was not recognized|function does not exist|function selector was not recognized/i.test(errMsg)) {
        throw Object.assign(new Error('claimFor not supported by market'), { code: 'UNSUPPORTED_CLAIM_FOR', cause: err });
      }
      throw err;
    }
  } else {
    tx = await market.claim();
  }

  const receipt = await tx.wait();
  const parsed = parseClaimEvent(receipt, market.interface);
  const burnedShares = parsed?.burnedShares ? parsed.burnedShares.toString() : null;
  const paidOutWei = parsed?.paidOut ? parsed.paidOut.toString() : null;
  const paidOut = parsed?.paidOut ? ethers.formatEther(parsed.paidOut) : null;

  console.log(
    JSON.stringify({
      success: true,
      marketAddress,
      wallet: claimWallet,
      usedClaimFor,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber ?? null,
      burnedSharesWei: burnedShares,
      paidOutWei,
      paidOut,
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
  if (detail) payload.detail = detail;
  if (err?.reason) payload.reason = err.reason;
  console.error(JSON.stringify(payload));
  process.exit(1);
});
