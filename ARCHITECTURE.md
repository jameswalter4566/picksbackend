# picksbackend — architecture

This repo is the backend home for **picks.run** prediction markets. It contains
the on-chain Solana program plus legacy BNB contracts (deprecated).

**Solana is the only supported chain as of 2026-05-18. BNB is deprecated.**

There is one source of truth in this codebase. There used to be a tangle of
sibling repos (`inkwell-backend`, `one-truth-launch`, scratch dirs) — those are
not authoritative. **picksbackend = the backend.**

---

## ⚠️ CRITICAL: Solana Program ID

**Current deployed program:** `3CioMvyUg4koYTYhPVk1CjkTFnS6QNgH1vyhyNxN2xtY`

### Program ID History

| Program ID | Status | What it was |
|------------|--------|-------------|
| `3CioMvyUg4koYTYhPVk1CjkTFnS6QNgH1vyhyNxN2xtY` | ✅ **CURRENT** | BNB-mirror YES/NO market (Token-2022 shares) |
| `4q4XQMgSgjpSuWKw4QPbSEZE7iKn2qAhjfGyMY7fZvKT` | ❌ **DEPRECATED** | Old program, do NOT use |

### Where the program ID must match

All of these MUST use `3CioMvyUg4koYTYhPVk1CjkTFnS6QNgH1vyhyNxN2xtY`:

| Location | File | Status |
|----------|------|--------|
| **This repo** | `programs/picks_market/src/lib.rs` (`declare_id!`) | ✅ Source of truth |
| **This repo** | `Anchor.toml` | ✅ Correct |
| **Frontend** | `SolPicks/src/lib/picksMarket.js` | ✅ Updated |
| **Frontend** | `SolPicks/src/lib/picks_market_idl.json` | ✅ Updated |
| **Frontend** | `SolPicks/.env.example` | ✅ Updated |
| **Edge fn** | `over_under/supabase/functions/launch-sol-market/index.ts` | ⚠️ **NEEDS UPDATE** |

### BNB is DEPRECATED

Do not use BNB. All BNB code in this repo is legacy:
- `contracts/prediction/*.sol` — not deployed for new picks
- `scripts/deploy-market.js` — not called for new picks
- Railway `/api/launch-evm-market` — legacy endpoint

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

## The BNB side (⚠️ DEPRECATED)

**DO NOT USE.** BNB support is deprecated as of 2026-05-18. This section is
kept for reference only. All new picks use Solana.

### What it did (legacy)

Same logic as the Solana program, but on BNB mainnet using Solidity contracts.
Each pick deployed its own `PredictionMarketNative` vault + two `OutcomeShare`
tokens (YES and NO). Resolution was owner-only. Claim was pro-rata.

### Legacy production flow (no longer used)

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

### Railway service (still running for legacy ops)

- **Service:** `picksbackend-production.up.railway.app`
- **Auto-deploys** on push to `jameswalter4566/picksbackend` main.
- **Health check:** `GET /health` → `ok`
- **CI/CD self-test:** `GET /api/deploy-check` → JSON marker + uptime

Operational scripts (`resolve-market.js`, `claim-market.js`, `manual-refund.js`)
are run by exec'ing into the Railway container with the production secrets
already loaded. These may still be needed for legacy BNB markets that need
resolution.

---

## Active chain: Solana only

**All new picks use Solana.** BNB is deprecated.

- `sol` markets → calls to the Anchor program deployed at
  `3CioMvyUg4koYTYhPVk1CjkTFnS6QNgH1vyhyNxN2xtY` on devnet (mainnet TBD).

The frontend (`SolPicks` repo) uses `SolMarketTradePanel` for trading.
The Supabase edge function `launch-sol-market` handles market creation.

Legacy `evm` / `native_bnb` markets may still exist in the database from
before the migration. These can still be resolved/claimed using the Railway
ops scripts, but no new BNB markets should be created.

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
