const { ethers } = require("hardhat");

async function main() {
  const DEFAULT_ASSET = '0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'; // WBNB (BSC mainnet)
  const asset        = process.env.ESCROW_ASSET || DEFAULT_ASSET;
  const feeBps       = Number(process.env.FEE_BPS || '300');
  if (!asset) throw new Error('Missing ESCROW_ASSET');

  const [signer] = await ethers.getSigners();
  const deployerAddr = await signer.getAddress();
  const owner        = process.env.RESOLVER || deployerAddr;
  const feeRecipient = process.env.FEE_RECIPIENT || deployerAddr;

  const now = Math.floor(Date.now()/1000);
  const endTime    = BigInt(now + 3*24*3600);
  const cutoffTime = BigInt(now + 3*24*3600 - 30*60);
  const namePrefix = 'Example Pick';

  console.log('Deployer:', deployerAddr);
  console.log('Owner/Resolver:', owner);
  console.log('Fee recipient:', feeRecipient);
  console.log('Asset:', asset, asset === DEFAULT_ASSET ? '(default WBNB)' : '');
  console.log('Fee bps:', feeBps);

  const Market = await ethers.getContractFactory('PredictionMarket');
  const market = await Market.deploy(owner, asset, endTime, cutoffTime, feeBps, feeRecipient, namePrefix);
  await market.waitForDeployment();
  const addr = await market.getAddress();
  console.log('Market:', addr);
  console.log('YesShare:', await market.yesShare());
  console.log('NoShare:', await market.noShare());
}

main().catch((e) => { console.error(e); process.exit(1); });
