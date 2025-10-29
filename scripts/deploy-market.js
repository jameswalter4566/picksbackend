const { ethers } = require("hardhat");

async function main() {
  const requestedAsset = process.env.ESCROW_ASSET ? process.env.ESCROW_ASSET.toLowerCase() : undefined;
  if (requestedAsset && requestedAsset !== 'native' && requestedAsset !== 'bnb') {
    throw new Error('Only native BNB markets are supported. Remove ESCROW_ASSET or set it to "native".');
  }
  const asset = 'native';
  const feeBps = Number(process.env.FEE_BPS || '300');

  const [signer] = await ethers.getSigners();
  const deployerAddr = await signer.getAddress();
  const owner        = process.env.RESOLVER || deployerAddr;
  const feeRecipient = process.env.FEE_RECIPIENT || deployerAddr;

  const now = Math.floor(Date.now()/1000);
  const envEnd   = process.env.END_TIME ? BigInt(process.env.END_TIME) : null;
  const envCut   = process.env.CUTOFF_TIME ? BigInt(process.env.CUTOFF_TIME) : null;
  const endTime    = envEnd ?? BigInt(now + 3*24*3600);
  const cutoffTime = envCut ?? BigInt(Number(endTime) - 30*60);
  const namePrefix = process.env.NAME_PREFIX || 'Example Pick';

  console.log('Deployer:', deployerAddr);
  console.log('Owner/Resolver:', owner);
  console.log('Fee recipient:', feeRecipient);
  console.log('Asset:', asset, '(native BNB)');
  console.log('Fee bps:', feeBps);

  const Market = await ethers.getContractFactory('PredictionMarketNative');
  const market = await Market.deploy(owner, endTime, cutoffTime, feeBps, feeRecipient, namePrefix);
  await market.waitForDeployment();
  const addr = await market.getAddress();
  const yes = await market.yesShare();
  const no = await market.noShare();

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
    };
    console.log(JSON.stringify(out));
  } else {
    console.log('Market:', addr);
    console.log('YesShare:', yes);
    console.log('NoShare:', no);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
