require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const { ANKR_API_KEY, DEPLOYER_PK, BSCSCAN_API_KEY } = process.env;
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
  },
  etherscan: {
    apiKey: BSCSCAN_API_KEY || '',
  },
};
