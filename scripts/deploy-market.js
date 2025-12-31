const { ethers } = require("hardhat");

function errorDetails(err) {
  if (!err) return {};
  return {
    name: err.name,
    message: err.message,
    shortMessage: err.shortMessage,
    code: err.code,
    reason: err.reason,
    data: err.data,
    transaction: err.transaction,
    receipt: err.receipt && {
      status: err.receipt.status,
      hash: err.receipt.hash,
      from: err.receipt.from,
      to: err.receipt.to,
      gasUsed: err.receipt.gasUsed && err.receipt.gasUsed.toString(),
      blockNumber: err.receipt.blockNumber,
    },
  };
}

async function main() {
  const requestedAsset = process.env.ESCROW_ASSET ? process.env.ESCROW_ASSET.toLowerCase() : undefined;
  if (requestedAsset && requestedAsset !== 'native' && requestedAsset !== 'bnb') {
    throw new Error('Only native BNB markets are supported. Remove ESCROW_ASSET or set it to "native".');
  }
  const asset = 'native';
  const feeBps = Number(process.env.FEE_BPS || '300');
  const DEFAULT_WRAPPED_NATIVE = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'; // WBNB mainnet
  const wrappedNative = (process.env.WRAPPED_NATIVE || DEFAULT_WRAPPED_NATIVE).trim();
  if (!wrappedNative || wrappedNative === ethers.ZeroAddress) {
    throw new Error('WRAPPED_NATIVE must be set to a valid token address.');
  }
  const creatorFeeRecipientRaw = process.env.CREATOR_FEE_RECIPIENT || '';
  const creatorFeeSplitBpsRaw = Number(process.env.CREATOR_FEE_SPLIT_BPS || '0');
  const creatorFeeRecipient = creatorFeeRecipientRaw && creatorFeeRecipientRaw.trim()
    ? creatorFeeRecipientRaw.trim()
    : ethers.ZeroAddress;
  const creatorFeeSplitBps = Number.isFinite(creatorFeeSplitBpsRaw)
    ? Math.max(0, Math.min(10_000, creatorFeeSplitBpsRaw))
    : 0;
  if (creatorFeeRecipient === ethers.ZeroAddress) {
    throw new Error('CREATOR_FEE_RECIPIENT is required; launch via the backend so the creator wallet is injected automatically.');
  }
  if (creatorFeeSplitBps <= 0) {
    throw new Error('CREATOR_FEE_SPLIT_BPS must be greater than zero.');
  }

  const [signer] = await ethers.getSigners();
  const deployerAddr = await signer.getAddress();
  const owner        = process.env.RESOLVER || deployerAddr;
  const feeRecipient = process.env.FEE_RECIPIENT || deployerAddr;

  const network = await ethers.provider.getNetwork();
  const feeData = await ethers.provider.getFeeData();
  const balance = await ethers.provider.getBalance(deployerAddr);

  const now = Math.floor(Date.now()/1000);
  const envEnd   = process.env.END_TIME ? BigInt(process.env.END_TIME) : null;
  const envCut   = process.env.CUTOFF_TIME ? BigInt(process.env.CUTOFF_TIME) : null;
  const endTime    = envEnd ?? BigInt(now + 3*24*3600);
  const cutoffTime = envCut ?? BigInt(Number(endTime) - 30*60);
  const namePrefix = process.env.NAME_PREFIX || 'Example Pick';

  console.log('Deployer:', deployerAddr);
  console.log('Owner/Resolver:', owner);
  console.log('Fee recipient:', feeRecipient);
  console.log('Network:', network.name, Number(network.chainId));
  console.log('Deployer balance:', balance.toString());
  console.log('Fee data:', {
    gasPrice: feeData.gasPrice && feeData.gasPrice.toString(),
    maxFeePerGas: feeData.maxFeePerGas && feeData.maxFeePerGas.toString(),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.toString(),
  });
  console.log('Asset:', asset, '(native BNB)');
  console.log('Fee bps:', feeBps);
  console.log('Wrapped native:', wrappedNative, wrappedNative.toLowerCase() === DEFAULT_WRAPPED_NATIVE ? '(default WBNB)' : '');
  console.log('Creator fee recipient:', creatorFeeRecipient === ethers.ZeroAddress ? '(none)' : creatorFeeRecipient);
  console.log('Creator fee split bps:', creatorFeeSplitBps);

  const Market = await ethers.getContractFactory('PredictionMarketNative');
  const market = await Market.deploy(
    owner,
    endTime,
    cutoffTime,
    feeBps,
    feeRecipient,
    creatorFeeRecipient,
    creatorFeeSplitBps,
    namePrefix,
    wrappedNative
  );
  console.log('Deploy tx:', market.deploymentTransaction && market.deploymentTransaction().hash);
  await market.waitForDeployment();
  const addr = await market.getAddress();
  const yes = await market.yesShare();
  const no = await market.noShare();
  const marketOwner = await market.owner();
  console.log('Market owner:', marketOwner, marketOwner.toLowerCase() === deployerAddr.toLowerCase() ? '(deployer)' : '(external)');
  console.log('Market address:', addr);
  console.log('Yes share:', yes);
  console.log('No share:', no);

  const prizeTransferAgent = process.env.PRIZE_TRANSFER_AGENT
    ? ethers.getAddress(process.env.PRIZE_TRANSFER_AGENT)
    : process.env.PRIZE_PRIVATE_KEY
      ? ethers.computeAddress(process.env.PRIZE_PRIVATE_KEY)
      : deployerAddr;
  if (prizeTransferAgent) {
    console.log('Setting prize transfer agent:', prizeTransferAgent);
    try {
      const tx = await market.setShareTransferAgent(prizeTransferAgent, true);
      console.log('Prize transfer agent tx:', tx.hash);
      const receipt = await tx.wait();
      console.log('Prize transfer agent receipt:', {
        status: receipt?.status,
        gasUsed: receipt?.gasUsed && receipt.gasUsed.toString(),
        blockNumber: receipt?.blockNumber,
      });
      console.log('Prize transfer agent enabled');
    } catch (err) {
      console.error('Prize transfer agent failed:', errorDetails(err));
      try {
        await market.callStatic.setShareTransferAgent(prizeTransferAgent, true);
      } catch (staticErr) {
        console.error('Prize transfer agent callStatic failed:', errorDetails(staticErr));
      }
      throw err;
    }
  }

  if (process.env.OUTPUT_JSON === '1') {
    const out = {
      success: true,
      deployer: deployerAddr,
      owner,
      feeRecipient,
      asset,
      marketType: 'native_bnb',
      feeBps,
      endTime: Number(endTime),
      cutoffTime: Number(cutoffTime),
      namePrefix,
      marketAddress: addr,
      yesShareAddress: yes,
      noShareAddress: no,
      prizeTransferAgent,
    };
    console.log(JSON.stringify(out));
  } else {
    console.log('Market:', addr);
    console.log('YesShare:', yes);
    console.log('NoShare:', no);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
