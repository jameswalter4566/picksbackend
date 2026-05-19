// Native-SOL YES/NO prediction market.
// 1:1 mirror of picksbackend/contracts/prediction/PredictionMarketNative.sol
// plus picksbackend/contracts/prediction/OutcomeShare.sol (non-transferable receipts).
//
// Lifecycle:
//   initialize_market  -> creates Market PDA, vault (system account PDA),
//                         YES/NO Token-2022 NonTransferable mints
//   buy_yes / buy_no   -> user transfers lamports; fee skim (platform + optional
//                         creator split with Solidity-identical math); net lands
//                         in vault PDA; 1 share = 1 lamport, minted to user ATA
//   resolve / force_resolve -> owner sets Yes | No | Invalid (force skips end-time gate)
//   claim / claim_for  -> Invalid refunds 1:1; winners burn shares for pro-rata
//                         payout from combined vault (last claimer takes remainder)

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::{
    self,
    spl_token_2022::{
        extension::ExtensionType,
        instruction as token_2022_ix,
        state::Mint as MintState,
    },
    Burn, MintTo, Token2022,
};
use anchor_spl::token_interface::{Mint, TokenAccount};

declare_id!("11111111111111111111111111111111"); // TODO: `anchor keys sync` after `solana-keygen new -o target/deploy/picks_market-keypair.json`

pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const YES_MINT_SEED: &[u8] = b"yes";
pub const NO_MINT_SEED: &[u8] = b"no";

pub const MAX_FEE_BPS: u16 = 1_000;     // 10% hard cap (Solidity has none; we add one for safety)
pub const MAX_SPLIT_BPS: u16 = 10_000;  // mirror of Solidity's `_creatorFeeSplitBps <= 10_000`
pub const SHARE_DECIMALS: u8 = 9;       // 1 share = 1 lamport (clean accounting)

#[program]
pub mod picks_market {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        args: InitializeMarketArgs,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(args.end_time > clock.unix_timestamp, PicksError::EndInPast);
        require!(args.cutoff_time < args.end_time, PicksError::CutoffNotBeforeEnd);
        require!(args.fee_bps <= MAX_FEE_BPS, PicksError::FeeTooHigh);
        require!(
            args.creator_fee_split_bps <= MAX_SPLIT_BPS,
            PicksError::SplitTooLarge
        );

        let market = &mut ctx.accounts.market;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        market.yes_mint_bump = ctx.bumps.yes_mint;
        market.no_mint_bump = ctx.bumps.no_mint;
        market.market_id = args.market_id;
        market.owner = ctx.accounts.owner.key();
        market.fee_recipient = args.fee_recipient;
        market.fee_bps = args.fee_bps;
        market.creator_fee_recipient = args.creator_fee_recipient;
        market.creator_fee_split_bps = args.creator_fee_split_bps;
        market.end_time = args.end_time;
        market.cutoff_time = args.cutoff_time;
        market.vault_yes = 0;
        market.vault_no = 0;
        market.final_outcome = Outcome::Pending as u8;
        market.resolved_pot = 0;
        market.remaining_pot = 0;
        market.winning_shares_remaining = 0;

        // Initialize each mint with NonTransferable extension, mint authority = Market PDA
        init_nontransferable_mint(
            &ctx.accounts.yes_mint.to_account_info(),
            &ctx.accounts.market.to_account_info(),
            &ctx.accounts.token_program,
            &ctx.accounts.rent,
        )?;
        init_nontransferable_mint(
            &ctx.accounts.no_mint.to_account_info(),
            &ctx.accounts.market.to_account_info(),
            &ctx.accounts.token_program,
            &ctx.accounts.rent,
        )?;

        emit!(MarketInitialized {
            market: market.key(),
            owner: market.owner,
            end_time: market.end_time,
            cutoff_time: market.cutoff_time,
            fee_bps: market.fee_bps,
        });
        Ok(())
    }

    pub fn buy_yes(ctx: Context<BuyYes>, amount: u64) -> Result<()> {
        let clock = Clock::get()?;
        let market = &mut ctx.accounts.market;
        require!(amount > 0, PicksError::ZeroAmount);
        require!(
            clock.unix_timestamp < market.cutoff_time,
            PicksError::TradingClosed
        );
        require!(
            market.final_outcome == Outcome::Pending as u8,
            PicksError::AlreadyResolved
        );

        let net = pay_fees_and_get_net(
            amount,
            market,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.fee_recipient,
            &ctx.accounts.creator_fee_recipient,
            &ctx.accounts.system_program,
        )?;

        // Net lamports to vault
        invoke(
            &system_instruction::transfer(
                ctx.accounts.user.key,
                &ctx.accounts.vault.key(),
                net,
            ),
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        market.vault_yes = market
            .vault_yes
            .checked_add(net)
            .ok_or(PicksError::MathOverflow)?;

        // Mint YES shares (1 share = 1 lamport of net)
        let market_id = market.market_id;
        let market_bump = market.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, market_id.as_ref(), &[market_bump]]];
        let cpi_accounts = MintTo {
            mint: ctx.accounts.yes_mint.to_account_info(),
            to: ctx.accounts.user_yes_ata.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_2022::mint_to(cpi_ctx, net)?;

        emit!(Bought {
            market: market.key(),
            user: ctx.accounts.user.key(),
            is_yes: true,
            amount_in: amount,
            shares_minted: net,
            fee: amount - net,
        });
        Ok(())
    }

    pub fn buy_no(ctx: Context<BuyNo>, amount: u64) -> Result<()> {
        let clock = Clock::get()?;
        let market = &mut ctx.accounts.market;
        require!(amount > 0, PicksError::ZeroAmount);
        require!(
            clock.unix_timestamp < market.cutoff_time,
            PicksError::TradingClosed
        );
        require!(
            market.final_outcome == Outcome::Pending as u8,
            PicksError::AlreadyResolved
        );

        let net = pay_fees_and_get_net(
            amount,
            market,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.fee_recipient,
            &ctx.accounts.creator_fee_recipient,
            &ctx.accounts.system_program,
        )?;

        invoke(
            &system_instruction::transfer(
                ctx.accounts.user.key,
                &ctx.accounts.vault.key(),
                net,
            ),
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        market.vault_no = market
            .vault_no
            .checked_add(net)
            .ok_or(PicksError::MathOverflow)?;

        let market_id = market.market_id;
        let market_bump = market.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, market_id.as_ref(), &[market_bump]]];
        let cpi_accounts = MintTo {
            mint: ctx.accounts.no_mint.to_account_info(),
            to: ctx.accounts.user_no_ata.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_2022::mint_to(cpi_ctx, net)?;

        emit!(Bought {
            market: market.key(),
            user: ctx.accounts.user.key(),
            is_yes: false,
            amount_in: amount,
            shares_minted: net,
            fee: amount - net,
        });
        Ok(())
    }

    pub fn resolve(ctx: Context<Resolve>, outcome: Outcome) -> Result<()> {
        _resolve(ctx, outcome, false)
    }

    pub fn force_resolve(ctx: Context<Resolve>, outcome: Outcome) -> Result<()> {
        _resolve(ctx, outcome, true)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        _claim(ctx, false)
    }

    pub fn claim_for(ctx: Context<Claim>) -> Result<()> {
        _claim(ctx, true)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Resolution + claim helpers
// ──────────────────────────────────────────────────────────────────────────────

fn _resolve(ctx: Context<Resolve>, outcome: Outcome, force: bool) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        market.final_outcome == Outcome::Pending as u8,
        PicksError::AlreadyResolved
    );
    require!(
        ctx.accounts.owner.key() == market.owner,
        PicksError::NotOwner
    );
    if !force {
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= market.end_time, PicksError::NotEnded);
    }
    require!(
        matches!(outcome, Outcome::Yes | Outcome::No | Outcome::Invalid),
        PicksError::BadOutcome
    );

    market.final_outcome = outcome as u8;

    if matches!(outcome, Outcome::Invalid) {
        market.resolved_pot = 0;
        market.remaining_pot = 0;
        market.winning_shares_remaining = 0;
    } else {
        let pot = market
            .vault_yes
            .checked_add(market.vault_no)
            .ok_or(PicksError::MathOverflow)?;
        market.resolved_pot = pot;
        market.remaining_pot = pot;
        // Winning side's total supply (Token-2022 Mint.supply)
        let winning_mint_ai = if matches!(outcome, Outcome::Yes) {
            ctx.accounts.yes_mint.to_account_info()
        } else {
            ctx.accounts.no_mint.to_account_info()
        };
        let mint_data = winning_mint_ai.data.borrow();
        // The base Mint state is the first 82 bytes (spl_token::state::Mint layout);
        // Token-2022 mints with extensions still keep the base layout at the start.
        let base = MintState::unpack_from_slice(&mint_data[..MintState::LEN])?;
        market.winning_shares_remaining = base.supply;
    }

    emit!(Resolved {
        market: market.key(),
        outcome: outcome as u8,
        forced: force,
    });
    Ok(())
}

fn _claim(ctx: Context<Claim>, is_claim_for: bool) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        market.final_outcome != Outcome::Pending as u8,
        PicksError::NotResolved
    );

    // claim_for => signer must be market.owner; user can be anyone
    // claim     => signer == user
    let user_key = ctx.accounts.user.key();
    if is_claim_for {
        require!(
            ctx.accounts.signer.key() == market.owner,
            PicksError::NotOwner
        );
    } else {
        require!(
            ctx.accounts.signer.key() == user_key,
            PicksError::NotOwner
        );
    }

    let outcome = market.final_outcome;
    let market_key = market.key();
    let vault_bump = market.vault_bump;
    let market_id = market.market_id;
    let market_bump = market.bump;

    if outcome == Outcome::Invalid as u8 {
        // Refund both legs 1:1
        let a = ctx.accounts.user_yes_ata.amount;
        let b = ctx.accounts.user_no_ata.amount;
        let refund = a.checked_add(b).ok_or(PicksError::MathOverflow)?;

        if a > 0 {
            burn_shares(
                &ctx.accounts.token_program,
                &ctx.accounts.yes_mint.to_account_info(),
                &ctx.accounts.user_yes_ata.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                a,
            )?;
        }
        if b > 0 {
            burn_shares(
                &ctx.accounts.token_program,
                &ctx.accounts.no_mint.to_account_info(),
                &ctx.accounts.user_no_ata.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                b,
            )?;
        }
        if refund > 0 {
            pda_vault_pay(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                refund,
            )?;
        }

        emit!(Claimed {
            market: market_key,
            user: user_key,
            burned_shares: refund,
            paid_out: refund,
        });
        return Ok(());
    }

    let yes_won = outcome == Outcome::Yes as u8;
    let (win_mint_ai, user_win_ata_ai, user_win_shares) = if yes_won {
        (
            ctx.accounts.yes_mint.to_account_info(),
            ctx.accounts.user_yes_ata.to_account_info(),
            ctx.accounts.user_yes_ata.amount,
        )
    } else {
        (
            ctx.accounts.no_mint.to_account_info(),
            ctx.accounts.user_no_ata.to_account_info(),
            ctx.accounts.user_no_ata.amount,
        )
    };
    require!(user_win_shares > 0, PicksError::NoShares);

    let shares_before = market.winning_shares_remaining;
    require!(shares_before > 0, PicksError::SharesExhausted);

    burn_shares(
        &ctx.accounts.token_program,
        &win_mint_ai,
        &user_win_ata_ai,
        &ctx.accounts.user.to_account_info(),
        user_win_shares,
    )?;

    let payout: u64 = if user_win_shares == shares_before {
        // Last claimer — sweep the remainder to avoid rounding loss
        let p = market.remaining_pot;
        market.remaining_pot = 0;
        market.winning_shares_remaining = 0;
        p
    } else {
        let p: u64 = ((market.remaining_pot as u128) * (user_win_shares as u128)
            / (shares_before as u128)) as u64;
        market.remaining_pot = market
            .remaining_pot
            .checked_sub(p)
            .ok_or(PicksError::MathOverflow)?;
        market.winning_shares_remaining = shares_before
            .checked_sub(user_win_shares)
            .ok_or(PicksError::MathOverflow)?;
        p
    };

    if payout > 0 {
        pda_vault_pay(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            payout,
        )?;
    }

    // suppress unused warnings for seeds (kept here for future signed CPIs)
    let _ = (vault_bump, market_id, market_bump, market_key);

    emit!(Claimed {
        market: market.key(),
        user: user_key,
        burned_shares: user_win_shares,
        paid_out: payout,
    });
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// Fee math (1:1 with PredictionMarketNative._buy)
// ──────────────────────────────────────────────────────────────────────────────

fn pay_fees_and_get_net<'info>(
    amount: u64,
    market: &Account<'info, Market>,
    user: &AccountInfo<'info>,
    fee_recipient: &AccountInfo<'info>,
    creator_fee_recipient: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<u64> {
    let fee: u64 = ((amount as u128) * (market.fee_bps as u128) / 10_000) as u64;
    let net = amount.checked_sub(fee).ok_or(PicksError::MathOverflow)?;

    if fee == 0 {
        return Ok(net);
    }

    let has_creator = market.creator_fee_recipient != Pubkey::default()
        && market.creator_fee_split_bps > 0;

    if has_creator {
        // Solidity semantic: creator_fee_split_bps is bps of GROSS trade (not of fee),
        // capped at the total fee. Keep this exact behavior.
        let mut creator_cut: u64 =
            ((amount as u128) * (market.creator_fee_split_bps as u128) / 10_000) as u64;
        if creator_cut > fee {
            creator_cut = fee;
        }
        let platform_cut = fee - creator_cut;

        if creator_cut > 0 {
            require_keys_eq!(
                creator_fee_recipient.key(),
                market.creator_fee_recipient,
                PicksError::WrongCreatorFeeRecipient
            );
            sys_transfer(user, creator_fee_recipient, system_program, creator_cut)?;
        }
        if platform_cut > 0 {
            require_keys_eq!(
                fee_recipient.key(),
                market.fee_recipient,
                PicksError::WrongFeeRecipient
            );
            sys_transfer(user, fee_recipient, system_program, platform_cut)?;
        }
    } else {
        require_keys_eq!(
            fee_recipient.key(),
            market.fee_recipient,
            PicksError::WrongFeeRecipient
        );
        sys_transfer(user, fee_recipient, system_program, fee)?;
    }

    Ok(net)
}

fn sys_transfer<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    lamports: u64,
) -> Result<()> {
    invoke(
        &system_instruction::transfer(from.key, to.key, lamports),
        &[from.clone(), to.clone(), system_program.to_account_info()],
    )?;
    Ok(())
}

fn pda_vault_pay<'info>(
    vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    // Vault PDA is a system-owned account holding lamports for the program;
    // direct lamport reassignment is the standard pattern for PDA outflows.
    let mut vault_lamports = vault.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;
    **vault_lamports = vault_lamports
        .checked_sub(lamports)
        .ok_or(PicksError::VaultUnderflow)?;
    **to_lamports = to_lamports
        .checked_add(lamports)
        .ok_or(PicksError::MathOverflow)?;
    Ok(())
}

fn burn_shares<'info>(
    token_program: &Program<'info, Token2022>,
    mint: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let cpi_accounts = Burn {
        mint: mint.clone(),
        from: from.clone(),
        authority: authority.clone(),
    };
    let cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts);
    token_2022::burn(cpi_ctx, amount)
}

// ──────────────────────────────────────────────────────────────────────────────
// Mint init helper (Token-2022 NonTransferable + InitializeMint2)
// ──────────────────────────────────────────────────────────────────────────────

fn init_nontransferable_mint<'info>(
    mint: &AccountInfo<'info>,
    mint_authority: &AccountInfo<'info>,
    token_program: &Program<'info, Token2022>,
    _rent: &Sysvar<'info, Rent>,
) -> Result<()> {
    // Account was created with the correct size in #[derive(Accounts)]; we just
    // need to wire the NonTransferable extension and then initialize the base mint.

    let nt_ix = token_2022_ix::initialize_non_transferable_mint(
        token_program.key,
        mint.key,
    )?;
    invoke(&nt_ix, &[mint.clone(), token_program.to_account_info()])?;

    let init_ix = token_2022_ix::initialize_mint2(
        token_program.key,
        mint.key,
        mint_authority.key,
        None,
        SHARE_DECIMALS,
    )?;
    invoke(&init_ix, &[mint.clone(), token_program.to_account_info()])?;

    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// Accounts
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(args: InitializeMarketArgs)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Market::SIZE,
        seeds = [MARKET_SEED, args.market_id.as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,

    /// Vault PDA — system-owned account holding pooled SOL.
    /// We create it as a zero-data PDA via `init` so it has a valid owner (system program)
    /// and can receive lamports via system_program::transfer.
    #[account(
        init,
        payer = owner,
        space = 0,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        owner = anchor_lang::solana_program::system_program::ID,
    )]
    /// CHECK: zero-data PDA used only as a lamport sink
    pub vault: AccountInfo<'info>,

    /// YES mint — Token-2022, NonTransferable, mint authority = Market PDA
    #[account(
        init,
        payer = owner,
        space = ExtensionType::try_calculate_account_len::<MintState>(
            &[ExtensionType::NonTransferable]
        ).unwrap(),
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
        owner = token_2022::ID,
    )]
    /// CHECK: hand-initialized as Token-2022 mint in handler
    pub yes_mint: AccountInfo<'info>,

    #[account(
        init,
        payer = owner,
        space = ExtensionType::try_calculate_account_len::<MintState>(
            &[ExtensionType::NonTransferable]
        ).unwrap(),
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
        owner = token_2022::ID,
    )]
    /// CHECK: hand-initialized as Token-2022 mint in handler
    pub no_mint: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token2022>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BuyYes<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    /// CHECK: PDA-owned system account, lamport sink only
    pub vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump = market.yes_mint_bump,
        mint::token_program = token_program,
    )]
    pub yes_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_yes_ata: InterfaceAccount<'info, TokenAccount>,

    /// Platform fee recipient. Checked in handler against market.fee_recipient.
    #[account(mut)]
    /// CHECK: address validated in handler
    pub fee_recipient: AccountInfo<'info>,

    /// Creator fee recipient. Checked in handler when split > 0. Pass any account
    /// (e.g. fee_recipient again) when creator split is unused.
    #[account(mut)]
    /// CHECK: address validated in handler
    pub creator_fee_recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct BuyNo<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    /// CHECK: PDA-owned system account, lamport sink only
    pub vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump = market.no_mint_bump,
        mint::token_program = token_program,
    )]
    pub no_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_no_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// CHECK: address validated in handler
    pub fee_recipient: AccountInfo<'info>,

    #[account(mut)]
    /// CHECK: address validated in handler
    pub creator_fee_recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump = market.yes_mint_bump,
        mint::token_program = token_program,
    )]
    pub yes_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump = market.no_mint_bump,
        mint::token_program = token_program,
    )]
    pub no_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// For `claim`, this is the user themselves. For `claim_for`, this is the owner.
    #[account(mut)]
    pub signer: Signer<'info>,

    /// The user whose shares are being burned and to whom the payout is sent.
    /// For `claim`, must equal signer; for `claim_for`, can be anyone.
    #[account(mut)]
    /// CHECK: address relationship validated in handler
    pub user: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    /// CHECK: PDA-owned system account
    pub vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump = market.yes_mint_bump,
        mint::token_program = token_program,
    )]
    pub yes_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump = market.no_mint_bump,
        mint::token_program = token_program,
    )]
    pub no_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_yes_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = no_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_no_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

#[account]
pub struct Market {
    pub bump: u8,
    pub vault_bump: u8,
    pub yes_mint_bump: u8,
    pub no_mint_bump: u8,
    pub market_id: [u8; 32],
    pub owner: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub creator_fee_recipient: Pubkey,
    pub creator_fee_split_bps: u16,
    pub end_time: i64,
    pub cutoff_time: i64,
    pub vault_yes: u64,
    pub vault_no: u64,
    pub final_outcome: u8,
    pub resolved_pot: u64,
    pub remaining_pot: u64,
    pub winning_shares_remaining: u64,
}

impl Market {
    // 1+1+1+1+32+32+32+2+32+2+8+8+8+8+1+8+8+8 = 191. Round up for headroom.
    pub const SIZE: usize = 256;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeMarketArgs {
    pub market_id: [u8; 32],
    pub end_time: i64,
    pub cutoff_time: i64,
    pub fee_bps: u16,
    pub fee_recipient: Pubkey,
    pub creator_fee_recipient: Pubkey,
    pub creator_fee_split_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
#[repr(u8)]
pub enum Outcome {
    Pending = 0,
    Yes = 1,
    No = 2,
    Invalid = 3,
}

// ──────────────────────────────────────────────────────────────────────────────
// Events
// ──────────────────────────────────────────────────────────────────────────────

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub end_time: i64,
    pub cutoff_time: i64,
    pub fee_bps: u16,
}

#[event]
pub struct Bought {
    pub market: Pubkey,
    pub user: Pubkey,
    pub is_yes: bool,
    pub amount_in: u64,
    pub shares_minted: u64,
    pub fee: u64,
}

#[event]
pub struct Resolved {
    pub market: Pubkey,
    pub outcome: u8,
    pub forced: bool,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub burned_shares: u64,
    pub paid_out: u64,
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum PicksError {
    #[msg("end_time must be in the future")]
    EndInPast,
    #[msg("cutoff_time must be before end_time")]
    CutoffNotBeforeEnd,
    #[msg("fee_bps exceeds MAX_FEE_BPS (10%)")]
    FeeTooHigh,
    #[msg("creator_fee_split_bps exceeds 10_000")]
    SplitTooLarge,
    #[msg("trading window closed (now >= cutoff_time)")]
    TradingClosed,
    #[msg("market already resolved")]
    AlreadyResolved,
    #[msg("market not yet ended; use force_resolve to skip the gate")]
    NotEnded,
    #[msg("market is not resolved")]
    NotResolved,
    #[msg("invalid outcome variant")]
    BadOutcome,
    #[msg("only the market owner may call this instruction")]
    NotOwner,
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("vault lamport underflow")]
    VaultUnderflow,
    #[msg("user holds no winning shares")]
    NoShares,
    #[msg("winning shares already fully claimed")]
    SharesExhausted,
    #[msg("fee_recipient account does not match market.fee_recipient")]
    WrongFeeRecipient,
    #[msg("creator_fee_recipient account does not match market.creator_fee_recipient")]
    WrongCreatorFeeRecipient,
}
