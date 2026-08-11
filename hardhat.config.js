require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const { ANKR_API_KEY, DEPLOYER_PK, BSCSCAN_API_KEY, RH_RPC_URL } = process.env;
// Use only ANKR_API_KEY for RPC URL
const RPC_URL = ANKR_API_KEY ? `https://rpc.ankr.com/bsc/${ANKR_API_KEY}` : '';

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.20',
  networks: {
    bscMainnet: {
      url: RPC_URL,
      chainId: 56,
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
    },
    // Robinhood Chain mainnet. Set RH_RPC_URL to the QuickNode endpoint in
    // production — the public RPC rate-limits (429) under sustained load.
    robinhoodMainnet: {
      url: RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
    },
  },
  etherscan: {
    apiKey: BSCSCAN_API_KEY || '',
  },
};
