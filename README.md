# Handshake — peer-to-peer swaps on BOT Chain

**Live on BOT Chain mainnet:** [`0xaF8c8A63A952534c23C2073AE567334612331DaD`](https://scan.botchain.ai/address/0xaF8c8A63A952534c23C2073AE567334612331DaD)
(deploy tx [`0x9a7c6cb3…`](https://scan.botchain.ai/tx/0x9a7c6cb37812d44fcc9cd1f00892f43ba977641f67efddd5e1896964428304b1))

Offer your BOT or tokens for someone else's. Your side waits in the contract; whoever
accepts pays you and receives it in the same transaction, so neither side has to go first
or trust the other. Offers can be public or locked to one wallet (share the `?offer=ID` link).

- Any pair: BOT ⇄ token, token ⇄ token
- The maker can cancel and get the deposit back any time before it's accepted — even after
  expiry and even while the app is paused
- A 0.3% fee is taken from the maker's side when a swap completes (hard-capped at 1%)
- Fee-on-transfer tokens are rejected on both legs, so every swap delivers exactly the stated amounts

## What the contract owner can and can't do
The owner can set the fee (≤ 1%), set the treasury and pause new offers/acceptances.
No function moves anyone's deposit; a test checks the full list.

## Security properties (covered by tests)
- Status is updated before any transfer; ReentrancyGuard on create/fill/cancel/collect
- Private offers can only be accepted by the named wallet; makers can't fill their own offers
- Expired offers can't be accepted
- Solvency: contract balance == open deposits + accrued fees, per token
- Two-step ownership transfer

## Run
```bash
npm install
npx hardhat test               # if the solc CDN is blocked: USE_SOLCJS=1 npx hardhat test
cp .env.example .env           # PRIVATE_KEY, BOT_RPC_URL, OWNER_ADDRESS, TREASURY_ADDRESS
npx hardhat run scripts/deploy.js --network botMainnet
```
Then put the printed address in `docs/index.html` → `CONFIG.contract` and deploy to Vercel
(Framework Preset: Other).

BOT Chain mainnet: chain ID 677, gas token BOT, explorer https://scan.botchain.ai.
