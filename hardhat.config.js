require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const { BSC_MAINNET_RPC, ANKR_API_KEY, DEPLOYER_PK, BSCSCAN_API_KEY } = process.env;
// Prefer explicit BSC_MAINNET_RPC. If absent, derive from ANKR_API_KEY.
const RPC_URL = BSC_MAINNET_RPC || (ANKR_API_KEY ? `https://rpc.ankr.com/bsc/${ANKR_API_KEY}` : '');

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.20',
  networks: {
    bscMainnet: {
      url: RPC_URL,
      chainId: 56,
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
    },
  },
  etherscan: {
    apiKey: BSCSCAN_API_KEY || '',
  },
};
