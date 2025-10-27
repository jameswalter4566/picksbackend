const { ethers } = require('hardhat');

const FACTORY_ABI = [
  "event MarketCreated(address indexed market)",
  "function createMarket(address owner_, address asset_, uint64 endTime_, uint64 cutoffTime_, uint16 feeBps_, address feeRecipient_, string namePrefix_) external returns (address)"
];

async function main() {
  const factoryAddr  = process.env.FACTORY_ADDR;
  const DEFAULT_ASSET = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'; // WBNB (BSC mainnet, lowercased)
  const asset        = (process.env.ESCROW_ASSET || DEFAULT_ASSET).toLowerCase();
  const feeBps       = Number(process.env.FEE_BPS || '300');
  if (!factoryAddr || !asset) throw new Error('Missing FACTORY_ADDR/ESCROW_ASSET');

  const now = Math.floor(Date.now()/1000);
  const endTime    = now + 3*24*3600;
  const cutoffTime = endTime - 30*60;
  const namePrefix = 'Example Pick';

  const [signer] = await ethers.getSigners();
  const deployerAddr = await signer.getAddress();
  const owner        = process.env.RESOLVER || deployerAddr;
  const feeRecipient = process.env.FEE_RECIPIENT || deployerAddr;
  console.log('Deployer:', deployerAddr);
  console.log('Owner/Resolver:', owner);
  console.log('Fee recipient:', feeRecipient);
  console.log('Asset:', asset, asset === DEFAULT_ASSET ? '(default WBNB)' : '');
  console.log('Fee bps:', feeBps);
  const factory  = new ethers.Contract(factoryAddr, FACTORY_ABI, signer);
  const tx = await factory.createMarket(owner, asset, endTime, cutoffTime, feeBps, feeRecipient, namePrefix);
  const rc = await tx.wait();

  let marketAddr = null;
  for (const log of rc.logs || []) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed.name === 'MarketCreated') {
        marketAddr = parsed.args.market;
        break;
      }
    } catch {}
  }
  console.log('Market:', marketAddr || '(see tx)');
}

main().catch((e) => { console.error(e); process.exit(1); });
