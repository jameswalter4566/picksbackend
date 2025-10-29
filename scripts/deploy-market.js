const { ethers } = require("hardhat");

async function main() {
  const DEFAULT_ASSET = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'; // WBNB (BSC mainnet, lowercased)
  const requestedAsset = process.env.ESCROW_ASSET ? process.env.ESCROW_ASSET.toLowerCase() : undefined;
  const useNative = process.env.MARKET_NATIVE === '1' || requestedAsset === 'native' || requestedAsset === 'bnb';
  const asset        = useNative ? 'native' : (requestedAsset || DEFAULT_ASSET);
  const feeBps       = Number(process.env.FEE_BPS || '300');
  if (!asset) throw new Error('Missing ESCROW_ASSET');

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
  console.log('Asset:', asset, useNative ? '(native BNB)' : (asset === DEFAULT_ASSET ? '(default WBNB)' : ''));
  console.log('Fee bps:', feeBps);

  const contractName = useNative ? 'PredictionMarketNative' : 'PredictionMarket';
  const Market = await ethers.getContractFactory(contractName);
  const market = useNative
    ? await Market.deploy(owner, endTime, cutoffTime, feeBps, feeRecipient, namePrefix)
    : await Market.deploy(owner, asset, endTime, cutoffTime, feeBps, feeRecipient, namePrefix);
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
      asset: useNative ? 'native' : asset,
      marketType: useNative ? 'native_bnb' : 'erc20',
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
