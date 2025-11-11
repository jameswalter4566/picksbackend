alter table public.picks
  add column if not exists creator_fee_recipient text,
  add column if not exists creator_fee_split_bps integer,
  add column if not exists evm_creator_fee_recipient text,
  add column if not exists evm_creator_fee_split_bps integer;

create index if not exists idx_picks_creator_fee_recipient on public.picks (lower(creator_fee_recipient));
create index if not exists idx_picks_evm_creator_fee_recipient on public.picks (lower(evm_creator_fee_recipient));
