# picks.run — Backend (Contracts & Ops)

This repository powers the smart-contract and operational side of picks.run, the first prediction market social platform built for retail consumers. Every time a creator launches a new pick in the UI, our backend stands up a pair of on-chain vaults (YES/NO) on BNB, routes fees to both the protocol and the creator, and exposes tooling so the prize wallet can buy and transfer reward shares during the attention flywheel campaign.

## Repository structure

| Path | Purpose |
| --- | --- |
| `contracts/prediction/OutcomeShare.sol` | Receipt token (YES/NO shares). Transferability can be toggled (used by prize wallet to gift shares). |
| `contracts/prediction/PredictionMarket.sol` | Generic ERC-20 stake variant (unused in production but kept for reference). |
| `contracts/prediction/PredictionMarketNative.sol` | Primary contract: native BNB vault with twin pools, creator fee split, transfer-agent support, and deterministic resolution hooks. |
| `scripts/deploy-market.js` | Deploys a single PredictionMarketNative instance (called by the Railway admin service). |
| `scripts/create-market.js` | Calls a factory (if configured) to spin up markets in bulk. |
| `scripts/claim-market.js` / `scripts/resolve-market.js` | Helpers to settle a market or force-claim for a wallet. |
| `scripts/manual-refund.js` | Legacy safety net to reimburse stuck users from pre-snapshot markets. |
| `hardhat.config.js` | Hardhat network configuration (BSC mainnet + verification). |
| `index.js` | Lightweight Express server exposing `/health` so Railway keeps the service alive (and so engineers can exec in to run scripts). |
| `supabase/` | Schema migrations relevant to backend jobs (e.g., creator fee tracking columns). |

## Why this matters

- **One market per prediction** – every pick on the frontend gets its own vault contract with YES/NO pools, so resolution and fee accounting stays isolated.
- **Creator revenue share** – 200–300 bps platform fee, with 150 bps automatically routed to the creator wallet stored in Supabase.
- **Attention flywheel** – prize wallet buys 0.01 BNB of YES/NO after a winning X reply is detected, then transfers the minted shares thanks to the `setShareTransferAgent` hook added to OutcomeShare.
- **Operational safety** – manuals scripts (refund, claimFor, resolve) provide backstops if an older market or settlement fails.

## Environment variables

Set these as Railway secrets (or locally via `.env` + `hardhat.config.js`):

| Variable | Description |
| --- | --- |
| `ANKR_API_KEY` | RPC key (used for read/write + trade indexing). |
| `DEPLOYER_PK` | Private key of the deployer/prize wallet (funded with small amount of BNB). |
| `PRIZE_PRIVATE_KEY` | Same as `DEPLOYER_PK` in production; used by Supabase Edge when gifting shares. |
| `BSCSCAN_API_KEY` | Optional, for contract verification. |
| `RESOLVER` | Address authorized to resolve markets; defaults to deployer. |
| `FEE_RECIPIENT` | Protocol fee sink; defaults to deployer. |
| `CREATOR_FEE_BPS` | Creator revenue share (default 150 bps). |
| `FEE_BPS` | Platform fee (default 300 bps). |
| `ESCROW_ASSET` | ERC-20 stake token (defaults to WBNB). Use only if not using the native market. |
| `WRAPPED_NATIVE` | WBNB address (defaults to canonical). |
| `FACTORY_ADDR` | Optional factory contract used by `scripts/create-market.js`. |
| `MARKET_ADDRESS`, `CLAIM_WALLET`, `REFUND_DIRECT` | Used by `manual-refund.js`. |

## Commands

```bash
npm install               # Install Hardhat + deps
npx hardhat compile       # Compile contracts
npm run deploy:market:mainnet   # scripts/deploy-market.js on BSC
npm run create:market:mainnet   # scripts/create-market.js on BSC (requires FACTORY_ADDR)
npm run refund:manual          # Run manual refund workflow for legacy markets
```

Railway keeps the service alive via `npm start` which calls `node index.js`; engineers SSH/exec into the container to run the scripts above with the production secrets already loaded.

## Launch flow (called by the frontend)

1. Creator fills out the “New pick” modal on the frontend.
2. Supabase stores the pick draft and calls a Railway webhook (`/api/launch-evm-market`) that wraps `scripts/deploy-market.js`.
3. The script deploys `PredictionMarketNative`, sets creator/prize wallets, enables transfer agent role, and returns the market + share addresses.
4. Frontend updates the pick row with these addresses and posts the X Poll.

## Claim flow support

- Supabase Edge function `claim-reward-shares` loads the pick row, determines the market/YES/NO token addresses, and uses `PRIZE_PRIVATE_KEY` to:
  1. Call `buyYesWithBNB` or `buyNoWithBNB` with 0.01 BNB.
  2. Call `OutcomeShare.transfer` to send the minted shares to the winner’s Privy wallet.
- To enable this, every new market automatically calls `yesShare.setShareTransferAgent(prizeWallet, true)` and the same for NO shares during deployment.
- Legacy markets (pre-change) can be patched by running the `setShareTransferAgent` transaction manually.

## Manual operations & safety nets

- **`scripts/claim-market.js`** – run when a user cannot claim due to UI issues; requires `MARKET_ADDRESS` and target wallet.
- **`scripts/manual-refund.js`** – computes payouts for legacy markets where the snapshot pot fix is absent and optionally wires the funds directly.
- **`scripts/resolve-market.js`** – sets the final outcome (YES, NO, INVALID) when the oracle or moderator has made a decision.

Before running any script in production:

1. `export DEPLOYER_PK=0x…` (never commit it).
2. Double-check gas estimates and targeted market addresses.
3. Monitor logs in Railway to confirm the transaction hash and new contract addresses.

## How judges can review

1. Clone this repo alongside the [frontend](https://github.com/picksdotrun/pciksdotrunfrontend).
2. Install dependencies and run `npx hardhat compile` to generate artifacts.
3. Inspect `scripts/deploy-market.js` to see exactly how markets are configured (fee bps, creator split, transfer agents).
4. Review `scripts/manual-refund.js` to understand the safety fallback for early users.
5. Optional: point Hardhat at BSC testnet, fund a throwaway wallet with test BNB, and run `npx hardhat run scripts/deploy-market.js --network bscTestnet` to watch a pick spin up.

---

Questions or security concerns? Reach us at security@picks.run or DM @picksdotrun on X. Thanks for evaluating picks.run! 
