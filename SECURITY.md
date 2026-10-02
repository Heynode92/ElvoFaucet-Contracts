# Security Model

Elvo Faucet is testnet-only infrastructure. The distributor is intentionally non-upgradeable and does not hold any minting authority.

## Privileged roles

- DEFAULT_ADMIN_ROLE: resumes a paused faucet, manages roles, and performs emergency recovery while paused.
- OPERATOR_ROLE: may only initiate claimFor(recipient). The backend relayer uses this role and pays transaction gas.
- PAUSER_ROLE: may stop claims but cannot resume them.

The deployer, admin, operator, and pauser addresses are required to be distinct by deployment preflight. The contract itself enforces distinct initial admin, operator, and pauser roles.

## Claim invariant

A wallet can receive one successful claim for the lifetime of this deployment. There is intentionally no resetClaim function.

The claimed flag is set before external interactions. Because EVM transactions are atomic, any failed ERC-20 or native transfer reverts the complete transaction and rolls the claimed flag back.

## Asset authority

The faucet never receives MINTER_ROLE for Elvo development assets. It distributes inventory that has been explicitly funded into the distributor contract.

The V1 asset package is fixed at deployment:

- 0.0001 native ETH
- 10 tUSDG
- 0.1 each of the ten Elvo development stock tokens

There are no post-deployment setters for payout amounts or token addresses.

## Emergency recovery

Recovery is admin-only and only available while the faucet is paused. Recovery cannot modify or clear lifetime claim history.

## Backend trust boundary

The contract guarantees operator authorization, atomic payout, fixed inventory configuration, pause controls, and one successful claim per recipient address.

The backend remains responsible for proving wallet ownership and anti-abuse controls before asking the operator signer to call claimFor.

## Key handling

Never commit .env, private keys, seed phrases, RPC credentials, or production secrets. The repository contains only .env.example.

A compromised operator key can spend faucet inventory only by issuing valid one-time claims to addresses. It cannot recover inventory, alter asset configuration, reset claim history, mint tokens, or unpause the faucet.
