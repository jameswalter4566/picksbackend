BNB Prediction Market — Backend Deploy Toolkit

This repository contains a minimal Hardhat setup to deploy the per‑pick prediction market contracts to BNB Smart Chain mainnet and to create new markets (one per pick) for your backend running on Railway.

What’s included
- contracts/prediction/
  - OutcomeShare.sol: Non‑transferable receipt token (YES/NO shares)
  - PredictionMarket.sol: Per‑pick market vault with buy/resolve/claim
- scripts/
  - deploy-market.js: Deploy a single market directly (no factory)
  - create-market.js: Call an existing Factory’s createMarket to deploy a market
- hardhat.config.js: Hardhat config with bscMainnet
- package.json: Commands to compile and run scripts

Service start command (Railway/Railpack)
- This repo includes a minimal `index.js` HTTP server and a `start` script so Railpack detects a start command.
- The server only exposes `/health` and a JSON status at `/` and listens on `PORT` (defaults to 3000).
- Use this service as a toolbox: exec into it and run the Hardhat scripts with env vars set.

Admin page
- Route: `GET /mein/arbeit`
- Protect with Railway secret `password_pin` (required). You sign in with the PIN and can launch a test market (vault) from the page.
- The page shows configured details (without exposing secrets) and a "Launch Program" button that deploys a test market via Hardhat and prints the transaction logs/addresses.

Environment variables (set in Railway)
- ANKR_API_KEY: required; RPC is `https://rpc.ankr.com/bsc/<ANKR_API_KEY>`
- DEPLOYER_PK: EOA private key (0x…) with a small amount of BNB for gas
- BSCSCAN_API_KEY (optional): for contract verification
- RESOLVER (optional): owner/resolver address. Defaults to deployer address if unset.
- FEE_RECIPIENT (optional): fee recipient address. Defaults to deployer address if unset.
- ESCROW_ASSET (optional): mainnet ERC‑20 used for staking; defaults to WBNB 0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c if unset
- FEE_BPS (optional): fee in basis points; defaults to 300 (3%)
- FACTORY_ADDR (optional): existing Factory address to create markets from

Install & compile
- npm i
- npx hardhat compile

Deploy a standalone market (no factory)
- npx hardhat run scripts/deploy-market.js --network bscMainnet

Create a market via existing Factory
- Ensure FACTORY_ADDR is set in Railway secrets
- npx hardhat run scripts/create-market.js --network bscMainnet

Run scripts on Railway
- Set secrets: ANKR_API_KEY, DEPLOYER_PK, (optional) ESCROW_ASSET, FEE_BPS, RESOLVER, FEE_RECIPIENT, FACTORY_ADDR, BSCSCAN_API_KEY
- If RESOLVER/FEE_RECIPIENT are omitted, scripts use the deployer address derived from DEPLOYER_PK.
- If ESCROW_ASSET is omitted, scripts default to WBNB.
- Exec into the running service and run a script, for example:
  - `npx hardhat run scripts/deploy-market.js --network bscMainnet`
  - or `npx hardhat run scripts/create-market.js --network bscMainnet`

Security notes
- Never commit secrets. Use Railway secrets for all env vars.
- Double‑check ESCROW_ASSET is the mainnet token address.
- Keep DEPLOYER_PK minimal and funded with small BNB.
