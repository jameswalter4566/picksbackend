# picks_market (Solana)

Native-SOL YES/NO prediction market. **1:1 mirror of
[`contracts/prediction/PredictionMarketNative.sol`](../../contracts/prediction/PredictionMarketNative.sol)
plus its [`OutcomeShare.sol`](../../contracts/prediction/OutcomeShare.sol)**
non-transferable receipt token — same repo, parallel chain.

## What it does

- One market per pick. Two pools: YES and NO.
- Users deposit native SOL into either side; receive Token-2022 NonTransferable
  YES/NO shares (1 share = 1 lamport of net deposit).
- Owner resolves the market to `Yes`, `No`, or `Invalid` after `end_time`
  (or via `force_resolve` for manual override).
- Winners burn their winning shares and receive a pro-rata cut of the entire
  combined pot (their pool + the losing pool). Last claimer sweeps the rounding
  remainder.
- `Invalid` refunds every share 1:1.
- Fees: platform `fee_bps` plus optional `creator_fee_split_bps` (matches the
  Solidity semantic of "bps of gross trade, capped at total fee").

## Solidity → Anchor map

| `PredictionMarketNative.sol` | `picks_market` |
| --- | --- |
| `constructor(...)` | `initialize_market(InitializeMarketArgs)` |
| `buyYesWithBNB()` payable | `buy_yes(amount: u64)` |
| `buyNoWithBNB()` payable | `buy_no(amount: u64)` |
| `resolve(Outcome)` onlyOwner | `resolve(outcome)` |
| `forceResolve(Outcome)` onlyOwner | `force_resolve(outcome)` |
| `claim()` | `claim()` |
| `claimFor(address)` onlyOwner | `claim_for()` |
| `vaultYes` / `vaultNo` | `Market.vault_yes` / `vault_no` |
| `yesShare` / `noShare` ERC20 | `yes_mint` / `no_mint` (Token-2022 NonTransferable) |
| `feeBps`, `feeRecipient` | `Market.fee_bps`, `Market.fee_recipient` |
| `creatorFeeRecipient`, `creatorFeeSplitBps` | `Market.creator_fee_recipient`, `Market.creator_fee_split_bps` |
| `resolvedPot`, `remainingPot`, `winningSharesRemaining` | same names on `Market` |
| `finalOutcome` enum | `Market.final_outcome: u8` + `Outcome` enum |

Added on the Solana side:
- `MAX_FEE_BPS = 1_000` (10% hard cap) — Solidity has none, we add safety.
- `SHARE_DECIMALS = 9` — 1 share = 1 lamport, integer-clean payout math.

Intentionally **not** ported in v1:
- `OutcomeShare.setTransferAgent` allowlist. Shares use Token-2022
  `NonTransferable` — transfers are fully disabled at the token-program level.
  When the X-poll prize-wallet gift flow is wanted on SOL, add a Token-2022
  `TransferHook` extension + companion hook program.

## Build & deploy

Requires Solana CLI 1.18.x, Anchor 0.30.x, Rust 1.75+.

```bash
# from picksbackend root
solana-keygen new -o target/deploy/picks_market-keypair.json
anchor keys sync
anchor build
anchor deploy --provider.cluster devnet
```

Until `anchor keys sync` runs, `declare_id!` and `Anchor.toml` both contain the
placeholder System Program address `11111111111111111111111111111111` — the
build will fail until you replace it.
