# picksbackend — architecture

This repo is the backend home for **picks.run** prediction markets. It contains
the on-chain code for both supported chains (BNB and Solana) plus the Railway
service that the frontend / Supabase edge functions call to spin up new markets.

There is one source of truth in this codebase. There used to be a tangle of
sibling repos (`inkwell-backend`, `one-truth-launch`, scratch dirs) — those are
not authoritative. **picksbackend = the backend.**

---

## What this codebase contains

| Path | Chain | Purpose |
| --- | --- | --- |
| `contracts/prediction/PredictionMarketNative.sol` | BNB | The original prediction market vault. Native BNB collateral, twin YES/NO pools, creator fee split. |
| `contracts/prediction/OutcomeShare.sol` | BNB | YES/NO receipt token. Non-transferable by default; owner-managed transfer-agent allowlist (for the prize-wallet gift flow). |
| `contracts/prediction/PredictionMarket.sol` | BNB | Older generic ERC-20-stake variant. Kept for reference, **not** used in prod. |
| `scripts/deploy-market.js` | BNB | Hardhat deploy script. Sets creator wallet, prize transfer agent, fee bps. |
| `scripts/resolve-market.js`, `scripts/claim-market.js`, `scripts/manual-refund.js` | BNB | Ops scripts run from inside the Railway container. |
| `programs/picks_market/` | **Solana** | New: native-SOL prediction market. **1:1 mirror** of `PredictionMarketNative.sol`. |
| `index.js` | — | Tiny Node HTTP server. Runs on Railway. Exposes `/api/launch-evm-market`, `/api/resolve-market`, `/api/claim-market`, `/api/deploy-check`, etc. Spawns the Hardhat scripts inside the container. |

---

## The Solana program (`programs/picks_market/`)

### What it does

A prediction market with two pools, YES and NO, denominated in native SOL.

1. Owner calls `initialize_market(args)` + `initialize_share_mints()` in one
   transaction → creates the Market PDA, vault PDA, and two Token-2022
   NonTransferable mints (YES and NO shares).
2. Users call `buy_yes(amount)` or `buy_no(amount)` — lamports flow into the
   vault PDA, fee skim goes to platform + creator, and they receive YES/NO
   shares (1 share = 1 lamport of net deposit).
3. After `end_time`, owner calls `resolve(Yes | No | Invalid)` (or
   `force_resolve` to bypass the timestamp gate).
4. Winners call `claim()` — burn their winning shares, receive a pro-rata
   payout from the entire combined pot. Last claimer sweeps the remainder.
5. If `Invalid`, every share refunds 1:1 to its holder.

### What it's a replica of

**`contracts/prediction/PredictionMarketNative.sol`** — same contract that
powers BNB markets in production. Same fee math, same resolution semantics,
same Invalid-refund behavior, same creator-fee-split logic.

| Solidity | Anchor |
| --- | --- |
| `constructor(...)` | `initialize_market(args)` + `initialize_share_mints()` |
| `buyYesWithBNB()` / `buyNoWithBNB()` | `buy_yes(amount)` / `buy_no(amount)` |
| `resolve(Outcome)` / `forceResolve(Outcome)` (onlyOwner) | `resolve(outcome)` / `force_resolve(outcome)` |
| `claim()` | `claim()` |
| `vaultYes`, `vaultNo` | `Market.vault_yes`, `Market.vault_no` (lamports) |
| `yesShare`, `noShare` ERC20 | `yes_mint`, `no_mint` (Token-2022 NonTransferable) |
| `feeBps`, `feeRecipient` | `Market.fee_bps`, `Market.fee_recipient` |
| `creatorFeeRecipient`, `creatorFeeSplitBps` | `Market.creator_fee_recipient`, `Market.creator_fee_split_bps` |

Added on the Solana side:
- `MAX_FEE_BPS = 1_000` (10% hard cap; the Solidity has none).
- `SHARE_DECIMALS = 9` (1 share = 1 lamport, integer-clean payout math).

Not yet ported:
- `OutcomeShare.setShareTransferAgent` allowlist — shares are fully
  non-transferable on Solana for now. The X-poll-reply gift flow (prize wallet
  buys + transfers shares to the winner) needs a Token-2022 `TransferHook`
  extension to work the same way. Future work.
- `claim_for(user)` — Token-2022 burns require the ATA owner's signature, so
  an admin can't burn on someone's behalf without a delegate setup. Dropped
  for v1; users self-claim.

### Deployment

- **Cluster:** devnet
- **Program ID:** `3CioMvyUg4koYTYhPVk1CjkTFnS6QNgH1vyhyNxN2xtY`
- **Authority:** the dev wallet (upgradeable)
- **Explorer:** https://explorer.solana.com/address/3CioMvyUg4koYTYhPVk1CjkTFnS6QNgH1vyhyNxN2xtY?cluster=devnet

Build and deploy from this repo root:

```bash
cargo build-sbf --manifest-path programs/picks_market/Cargo.toml
solana program deploy target/deploy/picks_market.so \
  --program-id target/deploy/picks_market-keypair.json \
  --url devnet --use-rpc --with-compute-unit-price 100000
```

`anchor build` / `anchor deploy` would also work — they wrap the same
underlying tools — but Anchor 0.30.1's CLI doesn't compile cleanly on modern
rustc (broken `time` crate dep), so `cargo build-sbf` is the path that works
on this machine today.

---

## The BNB side (still in production)

### What it does

Same logic as the Solana program, but on BNB mainnet using Solidity contracts.
Each pick deploys its own `PredictionMarketNative` vault + two `OutcomeShare`
tokens (YES and NO). Resolution is owner-only. Claim is pro-rata.

### Production flow

```
Frontend (picks.run)
    │
    ▼
Supabase Edge Function `launch-evm-market`
    │  (hardcoded URL: https://picksbackend-production.up.railway.app)
    ▼
Railway service  (node index.js → scripts/deploy-market.js)
    │  spawns Hardhat → BSC mainnet
    ▼
PredictionMarketNative + OutcomeShare(YES) + OutcomeShare(NO) deployed
    │
    ▼
Supabase row updated with market + share token addresses
    │
    ▼
post-to-x edge function publishes the X poll
```

### Deployment

- **Service:** `picksbackend-production.up.railway.app`
- **Auto-deploys** on push to `jameswalter4566/picksbackend` main.
- **Health check:** `GET /health` → `ok`
- **CI/CD self-test:** `GET /api/deploy-check` → JSON marker + uptime

Operational scripts (`resolve-market.js`, `claim-market.js`, `manual-refund.js`)
are run by exec'ing into the Railway container with the production secrets
already loaded.

---

## How the two chains relate

They're **parallel implementations of the same market design**, picked per
pick based on `picks.market_type` in Supabase:

- `evm` / `native_bnb` markets → BNB contracts deployed by this repo's
  Hardhat scripts via the Railway service.
- `sol` markets → calls to the Anchor program deployed at
  `3CioMvyUg4koYTYhPVk1CjkTFnS6QNgH1vyhyNxN2xtY` on devnet (mainnet TBD).

The frontend (`SolPicks` repo) renders the right trade panel
(`EvmTradePanel` or `SolMarketTradePanel`) and routes user actions to the
correct chain. The Supabase edge functions (`launch-evm-market`,
`launch-sol-market`) act as the single shared dispatcher.

---

## Reference: addresses & URLs

| What | Where |
| --- | --- |
| Solana program (devnet) | `3CioMvyUg4koYTYhPVk1CjkTFnS6QNgH1vyhyNxN2xtY` |
| Railway service | `https://picksbackend-production.up.railway.app` |
| GitHub origin | `https://github.com/jameswalter4566/picksbackend` |
| Supabase project | `picksdotrun` (ref `fbwzsmpytdjgbjpwkafy`) |
| Frontend repo | `SolPicks` (separate; not in this repo) |
| Supabase edge fn source | `over_under/supabase/functions/` (separate; not in this repo) |
