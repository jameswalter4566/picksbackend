const { ethers } = require('hardhat');

const OUTCOME = {
  Pending: 0,
  Yes: 1,
  No: 2,
  Invalid: 3,
};

function normalizeAddress(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} env var is required`);
  }
  const trimmed = value.trim();
  if (!ethers.isAddress(trimmed)) {
    throw new Error(`${label} must be a checksummed 0x address`);
  }
  return ethers.getAddress(trimmed);
}

function parseBooleanFromEnv(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

async function getShareContracts(market, signer) {
  const yesShareAddr = await market.yesShare();
  const noShareAddr = await market.noShare();
  if (!ethers.isAddress(yesShareAddr) || !ethers.isAddress(noShareAddr)) {
    throw new Error('Market does not expose share addresses');
  }
  const yesShare = await ethers.getContractAt('OutcomeShare', yesShareAddr, signer);
  const noShare = await ethers.getContractAt('OutcomeShare', noShareAddr, signer);
  return { yesShare, noShare, yesShareAddr, noShareAddr };
}

async function sendDirectRefund(signer, claimWallet, payoutWei) {
  console.log(
    `Sending direct refund of ${ethers.formatEther(payoutWei)} BNB from ${await signer.getAddress()} to ${claimWallet}`
  );
  const tx = await signer.sendTransaction({
    to: claimWallet,
    value: payoutWei,
  });
  const receipt = await tx.wait();
  console.log(`Direct refund tx hash: ${receipt.hash}`);
  return receipt;
}

async function main() {
  const deployerPk = process.env.DEPLOYER_PK;
  if (!deployerPk) {
    throw new Error('DEPLOYER_PK env var is required for signer access');
  }
  const marketAddress = normalizeAddress(process.env.MARKET_ADDRESS, 'MARKET_ADDRESS');
  const claimWallet = normalizeAddress(process.env.CLAIM_WALLET, 'CLAIM_WALLET');
  const preferDirectRefund = parseBooleanFromEnv(process.env.REFUND_DIRECT);

  const provider = ethers.provider;
  const signer = new ethers.Wallet(deployerPk, provider);
  const signerAddress = await signer.getAddress();

  const market = await ethers.getContractAt('PredictionMarketNative', marketAddress, signer);
  const contractOwner = await market.owner();
  if (ethers.getAddress(contractOwner) !== signerAddress) {
    console.warn(
      `Warning: signer ${signerAddress} does not match market owner ${contractOwner}. claimFor() may revert.`
    );
  }

  const [vaultYes, vaultNo, totalYesSupply, totalNoSupply] = await market.getTotals();
  const { yesShare, noShare, yesShareAddr, noShareAddr } = await getShareContracts(market, signer);
  const [userYesBalance, userNoBalance] = await Promise.all([
    yesShare.balanceOf(claimWallet),
    noShare.balanceOf(claimWallet),
  ]);
  const finalOutcome = Number(await market.finalOutcome());
  if (finalOutcome === OUTCOME.Pending) {
    throw new Error('Market is not resolved yet');
  }

  let payoutWei = 0n;
  let userWinningShares = 0n;
  let totalWinningSupply = 0n;
  if (finalOutcome === OUTCOME.Invalid) {
    payoutWei = userYesBalance + userNoBalance;
  } else {
    const yesWon = finalOutcome === OUTCOME.Yes;
    userWinningShares = yesWon ? userYesBalance : userNoBalance;
    totalWinningSupply = yesWon ? totalYesSupply : totalNoSupply;
    if (userWinningShares === 0n) {
      throw new Error('Wallet holds zero winning shares; nothing to reimburse');
    }
    if (totalWinningSupply === 0n) {
      throw new Error('Winning supply is zero; cannot compute payout');
    }
    payoutWei = ((vaultYes + vaultNo) * userWinningShares) / totalWinningSupply;
  }

  if (payoutWei === 0n) {
    console.log('Computed payout is 0. Nothing to refund.');
    return;
  }

  console.log(
    JSON.stringify(
      {
        marketAddress,
        claimWallet,
        finalOutcome,
        vaultYesWei: vaultYes.toString(),
        vaultNoWei: vaultNo.toString(),
        totalYesSupplyWei: totalYesSupply.toString(),
        totalNoSupplyWei: totalNoSupply.toString(),
        yesShareBalanceWei: userYesBalance.toString(),
        noShareBalanceWei: userNoBalance.toString(),
        payoutWei: payoutWei.toString(),
        payoutBNB: ethers.formatEther(payoutWei),
        yesShare: yesShareAddr,
        noShare: noShareAddr,
      },
      null,
      2
    )
  );

  if (preferDirectRefund) {
    await sendDirectRefund(signer, claimWallet, payoutWei);
    return;
  }

  const marketBalance = await provider.getBalance(marketAddress);
  if (marketBalance < payoutWei) {
    const topUp = payoutWei - marketBalance;
    console.log(
      `Topping up market vault by ${ethers.formatEther(topUp)} BNB so claimFor() can succeed (current balance ${ethers.formatEther(marketBalance)} BNB)`
    );
    const topUpTx = await signer.sendTransaction({
      to: marketAddress,
      value: topUp,
    });
    await topUpTx.wait();
    console.log(`Top-up tx hash: ${topUpTx.hash}`);
  } else {
    console.log(
      `Market already has ${ethers.formatEther(marketBalance)} BNB which is enough to cover the ${ethers.formatEther(payoutWei)} BNB payout`
    );
  }

  if (typeof market.callStatic?.claimFor === 'function') {
    try {
      await market.callStatic.claimFor(claimWallet);
    } catch (staticErr) {
      const errMsg = staticErr?.message || '';
      if (/execution reverted|revert|insufficient|denied/i.test(errMsg) && !/undefined/.test(errMsg)) {
        console.warn(`claimFor() would revert: ${errMsg}`);
        console.warn('Falling back to direct refund transfer.');
        await sendDirectRefund(signer, claimWallet, payoutWei);
        return;
      }
      console.warn(`claimFor() static call unavailable (${errMsg}). Continuing without preflight.`);
    }
  } else {
    console.warn('claimFor() static call helper missing; continuing without preflight.');
  }

  try {
    const tx = await market.claimFor(claimWallet);
    const receipt = await tx.wait();
    console.log(
      JSON.stringify(
        {
          success: true,
          action: 'claimFor',
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber ?? null,
          payoutWei: payoutWei.toString(),
          payoutBNB: ethers.formatEther(payoutWei),
          marketAddress,
          claimWallet,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.warn(`claimFor transaction reverted (${err?.message || err}). Sending direct refund instead.`);
    await sendDirectRefund(signer, claimWallet, payoutWei);
  }
}

main().catch((error) => {
  const message = error?.error?.message || error?.message || String(error);
  console.error('manual-refund failed:', message);
  if (error?.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
