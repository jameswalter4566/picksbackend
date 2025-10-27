const { ethers } = require("hardhat");

async function main() {
  const owner        = process.env.RESOLVER;
  const asset        = process.env.ESCROW_ASSET;
  const feeBps       = Number(process.env.FEE_BPS || '300');
  const feeRecipient = process.env.FEE_RECIPIENT;
  if (!owner || !asset || !feeRecipient) throw new Error('Missing RESOLVER/ESCROW_ASSET/FEE_RECIPIENT');

  const now = Math.floor(Date.now()/1000);
  const endTime    = BigInt(now + 3*24*3600);
  const cutoffTime = BigInt(now + 3*24*3600 - 30*60);
  const namePrefix = 'Example Pick';

  const Market = await ethers.getContractFactory('PredictionMarket');
  const market = await Market.deploy(owner, asset, endTime, cutoffTime, feeBps, feeRecipient, namePrefix);
  await market.waitForDeployment();
  const addr = await market.getAddress();
  console.log('Market:', addr);
  console.log('YesShare:', await market.yesShare());
  console.log('NoShare:', await market.noShare());
}

main().catch((e) => { console.error(e); process.exit(1); });

