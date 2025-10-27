require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const { BSC_MAINNET_RPC, DEPLOYER_PK, BSCSCAN_API_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.20',
  networks: {
    bscMainnet: {
      url: BSC_MAINNET_RPC || '',
      chainId: 56,
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
    },
  },
  etherscan: {
    apiKey: BSCSCAN_API_KEY || '',
  },
};

