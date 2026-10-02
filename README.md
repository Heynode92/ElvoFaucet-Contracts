# Elvo Faucet Contracts

Gasless testnet asset distribution for Elvo Exchange on Robinhood Chain Testnet.

## Claim package

One successful claim per wallet for the lifetime of the deployed distributor:

- 0.0001 native ETH
- 10 tUSDG
- 0.1 tNVDA
- 0.1 tTSLA
- 0.1 tAAPL
- 0.1 tMSFT
- 0.1 tMETA
- 0.1 tGOOGL
- 0.1 tAMZN
- 0.1 tCOIN
- 0.1 tSPY
- 0.1 tQQQ

Users do not submit an on-chain transaction. The Elvo Faucet backend verifies the user off-chain and an authorized operator calls claimFor(recipient), so the operator pays gas.

## Security properties

- one successful claim per recipient address
- fixed V1 token addresses and payout quantities
- atomic all-or-nothing package delivery
- SafeERC20 transfers
- reentrancy guard
- separate admin, operator, and pauser roles
- pauser cannot unpause
- emergency recovery requires the faucet to be paused
- no minting authority
- no upgradeability
- no claim-reset function
- deployment refuses the wrong chain
- deployment preflight validates every configured Elvo asset on-chain

See SECURITY.md for the trust model.

## Network

Robinhood Chain Testnet, chain ID 46630.

The deployment scripts use the same active development asset addresses registered by Elvo Exchange.

## Development

Requirements: Node.js 22.

Install and verify:

~~~text
npm ci
npm run check
~~~

Real deployment credentials belong only in local .env or an external secret store. Copy .env.example locally and never commit the resulting .env.

Before deployment:

~~~text
npm run deploy:preflight:testnet
~~~

Deploy only after preflight and CI are green:

~~~text
npm run deploy:testnet
~~~

For an intentional replacement deployment after changing immutable contract configuration, use:

~~~text
npm run redeploy:testnet
~~~

This explicit command deploys a new contract and records the previous contract in the new local deployment state. It does not modify the old on-chain deployment.

## Funding inventory

Funding is performed from the canonical Elvo development treasury. The treasury private key must exist only in the local ignored `.env` as `TREASURY_PRIVATE_KEY`; never commit or share it.

Preview a proportional inventory top-up for 100 additional claims:

~~~text
npm run fund:testnet -- --claims=100 --dry-run
~~~

After reviewing the plan, execute the top-up:

~~~text
npm run fund:testnet -- --claims=100 --confirm=ELVO_FAUCET_FUND
~~~

The script validates the network, treasury signer, active local deployment, on-chain faucet configuration, treasury balances, and gas budget. It then sends native ETH, tUSDG, and all ten stock assets sequentially and verifies that `availableClaims` increased by the requested number.

After funding the deployed distributor, verify runtime state:

~~~text
npm run verify:testnet
~~~
